import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAutoPost } from './knowledge.js';
import { publishTelegram, ALLOWED_TARGETS } from './telegram.js';
import { publishVk } from './vk.js';
import { logPublication } from './postslog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUTOPILOT_FILE = path.join(__dirname, '..', 'config', 'autopilot.json');
const AUTOPILOT_OVERRIDE_FILE = '/data/autopilot_override.json';
const AUTOPILOT_STATE_FILE = '/data/autopilot_state.json';
const AUTOPILOT_DEFAULT = { enabled: false, time: '10:00', days: [1, 2, 3, 4, 5], channels: ['tg', 'vk'] };

export function ensureAutopilotConfig() {
  try {
    if (!fs.existsSync(AUTOPILOT_FILE)) {
      fs.mkdirSync(path.dirname(AUTOPILOT_FILE), { recursive: true });
      fs.writeFileSync(AUTOPILOT_FILE, JSON.stringify(AUTOPILOT_DEFAULT, null, 2));
    }
  } catch (e) {
    console.log(`autopilot ERROR config create: ${e.message}`);
  }
}

function loadAutopilotConfig() {
  try {
    const file = fs.existsSync(AUTOPILOT_OVERRIDE_FILE) ? AUTOPILOT_OVERRIDE_FILE : AUTOPILOT_FILE;
    return { ...AUTOPILOT_DEFAULT, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ...AUTOPILOT_DEFAULT };
  }
}

export function getAutopilotConfig() {
  return loadAutopilotConfig();
}

export function saveAutopilotOverride(cfg) {
  fs.mkdirSync(path.dirname(AUTOPILOT_OVERRIDE_FILE), { recursive: true });
  fs.writeFileSync(AUTOPILOT_OVERRIDE_FILE, JSON.stringify(cfg, null, 2));
  console.log('autopilot config updated via API');
}

function autopilotLastRun() {
  try {
    return JSON.parse(fs.readFileSync(AUTOPILOT_STATE_FILE, 'utf8')).lastRun || null;
  } catch (e) {
    return null;
  }
}

function saveAutopilotLastRun(day) {
  try {
    fs.mkdirSync(path.dirname(AUTOPILOT_STATE_FILE), { recursive: true });
    fs.writeFileSync(AUTOPILOT_STATE_FILE, JSON.stringify({ lastRun: day }, null, 2));
  } catch (e) {
    console.log(`autopilot ERROR state save: ${e.message}`);
  }
}

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '');
}

export async function autopilotTick() {
  const cfg = loadAutopilotConfig();
  console.log(`autopilot: tick enabled=${cfg.enabled}`);
  if (!cfg.enabled) return;

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== cfg.time) return;
  if (!Array.isArray(cfg.days) || !cfg.days.includes(now.getDay())) return;

  const today = now.toISOString().slice(0, 10);
  if (autopilotLastRun() === today) return;
  saveAutopilotLastRun(today);

  try {
    const { topic, text } = await generateAutoPost();
    console.log(`autopilot: generated topic=${topic}`);
    const clean = stripMarkdown(text);
    const publishedChannels = [];
    for (const ch of cfg.channels || []) {
      try {
        let url = null;
        if (ch === 'tg') {
          url = ALLOWED_TARGETS[0];
          await publishTelegram(url, clean, null);
        } else if (ch === 'vk') {
          url = ALLOWED_TARGETS.find((t) => t.includes('vk.ru')) || null;
          await publishVk(clean, null);
        } else continue;
        publishedChannels.push({ name: ch, ok: true, url });
        console.log(`autopilot: published ${ch} OK`);
      } catch (e) {
        console.log(`autopilot ERROR publish ${ch}: ${e.message}`);
      }
    }
    if (publishedChannels.length) {
      logPublication({ topic, text: clean, channels: publishedChannels });
    }
  } catch (e) {
    console.log(`autopilot ERROR ${e.message}`);
  }
}
