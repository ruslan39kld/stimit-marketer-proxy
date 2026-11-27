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

const MOSCOW_TZ = 'Europe/Moscow';
const WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const moscowFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: MOSCOW_TZ,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function moscowNow() {
  const parts = Object.fromEntries(
    moscowFmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return {
    hhmm: `${parts.hour}:${parts.minute}`,
    day: WEEKDAY_TO_NUM[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export async function autopilotTick() {
  const cfg = loadAutopilotConfig();
  console.log(`autopilot: tick enabled=${cfg.enabled}`);
  if (!cfg.enabled) return;

  const nowMsk = moscowNow();
  const dayMatches = Array.isArray(cfg.days) && cfg.days.includes(nowMsk.day);
  const matched = nowMsk.hhmm === cfg.time && dayMatches;
  console.log(`autopilot: tick мск=${nowMsk.date} ${nowMsk.hhmm} день=${nowMsk.day} задано=${cfg.time} дни=${JSON.stringify(cfg.days)} совпало=${matched ? 'да' : 'нет'}`);
  if (!matched) return;

  const today = nowMsk.date;
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
