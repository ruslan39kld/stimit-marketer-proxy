import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWithGigachat } from './gigachat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KB_FILE = path.join(__dirname, '..', 'kb', 'stimit_base.md');
const AUTO_STATE_FILE = '/data/auto_state.json';

function parseTopics(base) {
  const lines = base.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('## ТЕМЫ ДЛЯ ПОСТОВ'));
  if (start === -1) return [];
  const topics = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) break;
    const m = line.match(/^\d+\.\s+(.+)/);
    if (m) topics.push(m[1].trim());
  }
  return topics;
}

function loadAutoState() {
  try {
    const data = JSON.parse(fs.readFileSync(AUTO_STATE_FILE, 'utf8'));
    return { topicIndex: Number(data.topicIndex) || 0 };
  } catch (e) {
    return { topicIndex: 0 };
  }
}

function saveAutoState(state) {
  try {
    fs.mkdirSync(path.dirname(AUTO_STATE_FILE), { recursive: true });
    fs.writeFileSync(AUTO_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.log(`auto state save ERROR: ${e.message}`);
  }
}

export async function generateAutoPost() {
  let base;
  try {
    base = fs.readFileSync(KB_FILE, 'utf8');
  } catch (e) {
    throw Object.assign(new Error('no_base'), { code: 'no_base' });
  }

  const topics = parseTopics(base);
  if (!topics.length) {
    throw Object.assign(new Error('no_base'), { code: 'no_base' });
  }

  const state = loadAutoState();
  const topic = topics[state.topicIndex % topics.length];

  const systemPrompt = [
    'Ты — SMM-агент студии STIMIT. Ниже — база знаний студии.',
    '',
    base,
    '',
    `Тема поста: ${topic}`,
    '',
    'Напиши пост по этой теме, строго соблюдая правила из разделов ТОН И СТИЛЬ и ЗАПРЕТЫ базы знаний.',
  ].join('\n');
  const text = await generateWithGigachat(topic, systemPrompt);
  saveAutoState({ topicIndex: (state.topicIndex + 1) % topics.length });
  return { topic, text };
}
