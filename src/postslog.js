import fs from 'node:fs';
import path from 'node:path';

const POSTS_FILE = '/data/posts.json';
const MAX_POSTS = 100;

function readPostsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

export function logPublication({ topic = null, text, channels }) {
  try {
    const posts = readPostsFile();
    posts.push({ ts: new Date().toISOString(), topic, text, channels });
    fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true });
    fs.writeFileSync(POSTS_FILE, JSON.stringify(posts.slice(-MAX_POSTS), null, 2));
  } catch (e) {
    console.log(`posts log ERROR: ${e.message}`);
  }
}

export function getRecentPosts(limit = 50) {
  return readPostsFile().slice(-limit).reverse();
}
