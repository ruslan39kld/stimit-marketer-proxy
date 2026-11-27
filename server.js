import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWithGigachat } from './src/gigachat.js';
import { publishTelegram, ALLOWED_TARGETS } from './src/telegram.js';
import { vkToken, tokenDesc, loadVkToken, publishVk, vkSelfTest } from './src/vk.js';
import { generateAutoPost } from './src/knowledge.js';
import { ensureAutopilotConfig, autopilotTick, getAutopilotConfig, saveAutopilotOverride } from './src/autopilot.js';
import { logPublication, getRecentPosts } from './src/postslog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STOP_WORDS = [
  'сука', 'блядь', 'хуй', 'пизд', 'ебал', 'ебат',
  'нацизм', 'нацист', 'террор', 'террорист', 'захват власти', 'свержение',
];

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin && req.headers.origin === origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory rate limiting: <=3 requests / 5 min per IP, <=20 / day per IP
const hits = new Map(); // ip -> number[] (timestamps, ms)
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_1D = 24 * 60 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_1D);
  hits.set(ip, list);
  if (list.filter((t) => now - t < WINDOW_5M).length >= 3) return true;
  if (list.length >= 20) return true;
  list.push(now);
  return false;
}

function hasStopWords(text) {
  const lower = text.toLowerCase();
  return STOP_WORDS.find((w) => lower.includes(w));
}

app.post('/publish', async (req, res) => {
  const { platform, target, text, imageUrl } = req.body || {};

  if (!['tg', 'vk'].includes(platform) || typeof target !== 'string' ||
      typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'invalid_request' });
  }
  if (imageUrl !== null && typeof imageUrl !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_image' });
  }

  if (!ALLOWED_TARGETS.includes(target)) {
    console.log(`publish denied: platform=${platform} target=${target} status=forbidden`);
    return res.status(403).json({ ok: false, error: 'target_not_allowed' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    console.log(`publish denied: platform=${platform} target=${target} status=rate_limited`);
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const bad = hasStopWords(text);
  if (bad) {
    console.log(`publish denied: platform=${platform} target=${target} status=blocked_word`);
    return res.status(422).json({ ok: false, error: 'blocked_word', reason: `stop_word:${bad}` });
  }

  try {
    const result = platform === 'tg'
      ? await publishTelegram(target, text, imageUrl)
      : await publishVk(text, imageUrl);
    console.log(`published: platform=${platform} target=${target} status=ok`);
    const url = platform === 'tg'
      ? target
      : ALLOWED_TARGETS.find((t) => t.includes('vk.ru')) || target;
    logPublication({ topic: null, text, channels: [{ name: platform, ok: true, url }] });
    res.json({ ok: true, result });
  } catch (e) {
    console.log(`publish failed: platform=${platform} target=${target} status=error`);
    res.status(502).json({ ok: false, error: 'upstream_error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Журнал публикаций ---
app.get('/api/posts', (req, res) => {
  res.json(getRecentPosts(50));
});

// --- API управления автопилотом ---
const apHits = new Map(); // ip -> number[]

function apRateLimited(ip) {
  const now = Date.now();
  const list = (apHits.get(ip) || []).filter((t) => now - t < GEN_WINDOW_1H);
  apHits.set(ip, list);
  if (list.length >= 30) return true;
  list.push(now);
  return false;
}

function validAutopilotConfig(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.enabled !== 'boolean') return false;
  if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return false;
  if (!Array.isArray(body.days) || !body.days.length ||
      !body.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return false;
  if (!Array.isArray(body.channels) || !body.channels.length ||
      !body.channels.every((c) => c === 'tg' || c === 'vk')) return false;
  return true;
}

app.get('/api/autopilot', (req, res) => {
  res.json(getAutopilotConfig());
});

app.post('/api/autopilot', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (apRateLimited(ip)) {
    console.log('autopilot config denied: status=rate_limited');
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }
  if (!validAutopilotConfig(req.body)) {
    return res.status(400).json({ ok: false, error: 'invalid_request' });
  }
  const { enabled, time, days, channels } = req.body;
  try {
    saveAutopilotOverride({ enabled, time, days, channels });
    res.json({ ok: true });
  } catch (e) {
    console.log(`autopilot config save ERROR: ${e.message}`);
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

// --- Статика фронта ---
app.use(express.static(__dirname));

const genHits = new Map(); // ip -> number[]
const GEN_WINDOW_1H = 60 * 60 * 1000;

function genRateLimited(ip) {
  const now = Date.now();
  const list = (genHits.get(ip) || []).filter((t) => now - t < GEN_WINDOW_1H);
  genHits.set(ip, list);
  if (list.length >= 10) return true;
  list.push(now);
  return false;
}

// --- GigaChat: генерация постов ---
app.post('/generate', async (req, res) => {
  const { task } = req.body || {};
  if (typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ ok: false, error: 'invalid_request' });
  }
  if (!process.env.GIGACHAT_CREDENTIALS) {
    return res.status(500).json({ ok: false, error: 'gigachat_not_configured' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (genRateLimited(ip)) {
    console.log('generate denied: status=rate_limited');
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    const text = await generateWithGigachat(task.trim());
    console.log('generate: status=ok');
    res.json({ text, imageUrl: null });
  } catch (e) {
    console.log(`generate failed: status=error reason=${e.message}`);
    res.status(500).json({ ok: false, error: 'generation_failed', reason: e.message });
  }
});

// --- Авто-генерация поста из базы знаний ---
const autoHits = new Map(); // ip -> number[]

function autoRateLimited(ip) {
  const now = Date.now();
  const list = (autoHits.get(ip) || []).filter((t) => now - t < GEN_WINDOW_1H);
  autoHits.set(ip, list);
  if (list.length >= 5) return true;
  list.push(now);
  return false;
}

app.post('/generate-auto', async (req, res) => {
  if (!process.env.GIGACHAT_CREDENTIALS) {
    return res.status(500).json({ ok: false, error: 'gigachat_not_configured' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (autoRateLimited(ip)) {
    console.log('auto generate denied: status=rate_limited');
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    const { topic, text } = await generateAutoPost();
    console.log(`auto generate: topic=${topic} status=ok`);
    res.json({ ok: true, topic, text });
  } catch (e) {
    if (e.code === 'no_base') {
      console.log('knowledge base missing');
      return res.status(503).json({ error: 'no_base' });
    }
    console.log(`auto generate failed: status=error reason=${e.message}`);
    res.status(500).json({ ok: false, error: 'generation_failed', reason: e.message });
  }
});

// --- Автопилот: генерация и публикация по расписанию ---
const port = Number(process.env.PORT) || 3000;
loadVkToken();
app.listen(port, () => {
  console.log(`proxy listening on ${port}`);
  console.log(`vk token: ${tokenDesc(vkToken.access_token)}`);
  console.log(`tg token: ${tokenDesc(process.env.TELEGRAM_BOT_TOKEN)}`);
  ensureAutopilotConfig();
  setInterval(autopilotTick, 60 * 1000);
  vkSelfTest();
});
