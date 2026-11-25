import express from 'express';

const ALLOWED_TARGETS = [
  'https://t.me/stimit_ai_marketer_demo',
  'https://vk.ru/stimit_ai_marketer_demo',
];

const STOP_WORDS = [
  'сука', 'блядь', 'хуй', 'пизд', 'ебал', 'ебат',
  'нацизм', 'нацист', 'террор', 'террорист', 'захват власти', 'свержение',
];

const VK_OWNER_ID = -243694741;
const VK_API_VERSION = '5.199';
const TG_API = 'https://api.telegram.org';
const VK_API = 'https://api.vk.ru/method';

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

function chatIdFromTarget(target) {
  const m = target.match(/^https?:\/\/t\.me\/([\w]+)/);
  return m ? '@' + m[1] : null;
}

async function publishTelegram(target, text, imageUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('telegram_not_configured');
  const chat_id = chatIdFromTarget(target);
  if (!chat_id) throw new Error('bad_target');
  if (imageUrl) {
    const r = await fetch(`${TG_API}/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, photo: imageUrl, caption: text }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error('telegram_api_error');
    return { id: data.result?.message_id };
  }
  const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error('telegram_api_error');
  return { id: data.result?.message_id };
}

async function vkCall(method, params) {
  const token = process.env.VK_ACCESS_TOKEN;
  if (!token) throw new Error('vk_not_configured');
  const body = new URLSearchParams({
    ...params,
    access_token: token,
    v: VK_API_VERSION,
  });
  const r = await fetch(`${VK_API}/${method}`, { method: 'POST', body });
  const data = await r.json();
  if (data.error) throw new Error(`vk_api_error_${data.error.error_code}`);
  return data.response;
}

async function vkUploadWallPhoto(imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error('vk_image_fetch_failed');
  const blob = await imgRes.blob();

  const server = await vkCall('photos.getWallUploadServer', {
    group_id: String(Math.abs(VK_OWNER_ID)),
  });

  const form = new FormData();
  form.append('photo', blob, 'photo.jpg');
  const up = await fetch(server.upload_url, { method: 'POST', body: form });
  const uploaded = await up.json();
  if (!uploaded.photo) throw new Error('vk_upload_failed');

  const saved = await vkCall('photos.saveWallPhoto', {
    group_id: String(Math.abs(VK_OWNER_ID)),
    photo: uploaded.photo,
    server: String(uploaded.server),
    hash: uploaded.hash,
  });
  const photo = Array.isArray(saved) ? saved[0] : saved;
  if (!photo?.owner_id || !photo?.id) throw new Error('vk_save_failed');
  return `photo${photo.owner_id}_${photo.id}`;
}

async function publishVk(text, imageUrl) {
  const params = {
    owner_id: String(VK_OWNER_ID),
    message: text,
  };
  if (imageUrl) {
    params.attachments = await vkUploadWallPhoto(imageUrl);
  }
  const res = await vkCall('wall.post', params);
  return { id: res.post_id };
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
    res.json({ ok: true, result });
  } catch (e) {
    console.log(`publish failed: platform=${platform} target=${target} status=error`);
    res.status(502).json({ ok: false, error: 'upstream_error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`proxy listening on ${port}`));
