import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAutoPost } from './knowledge.js';
import { publishTelegram, ALLOWED_TARGETS } from './telegram.js';
import { publishVk } from './vk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUTOPILOT_FILE = path.join(__dirname, '..', 'config', 'autopilot.json');
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
    return { ...AUTOPILOT_DEFAULT, ...JSON.parse(fs.readFileSync(AUTOPILOT_FILE, 'utf8')) };
  } catch (e) {
    return { ...AUTOPILOT_DEFAULT };
  }
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
    for (const ch of cfg.channels || []) {
      try {
        if (ch === 'tg') await publishTelegram(ALLOWED_TARGETS[0], clean, null);
        else if (ch === 'vk') await publishVk(clean, null);
        else continue;
        console.log(`autopilot: published ${ch} OK`);
      } catch (e) {
        console.log(`autopilot ERROR publish ${ch}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`autopilot ERROR ${e.message}`);
  }
}
