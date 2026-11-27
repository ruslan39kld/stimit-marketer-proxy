import crypto from 'node:crypto';
import https from 'node:https';

const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const GIGACHAT_CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
const GIGACHAT_SCOPE = 'GIGACHAT_API_PERS';

// Как в Stimit 3.0 (server/gigachat.ts): сертификат Минцифры не используем,
// проверка цепочки TLS отключена на агенте GigaChat.
const gigachatAgent = new https.Agent({ rejectUnauthorized: false });

let cachedToken = null; // { token, expiresAt }

function httpsPostJson(url, { headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        agent: gigachatAgent,
        headers: { 'Content-Length': Buffer.byteLength(payload), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getGigachatToken() {
  const credentials = process.env.GIGACHAT_CREDENTIALS;
  if (!credentials) throw new Error('gigachat_not_configured');
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const res = await httpsPostJson(GIGACHAT_OAUTH_URL, {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'RqUID': crypto.randomUUID(),
    },
    body: `scope=${GIGACHAT_SCOPE}`,
    timeoutMs: 30000,
  });
  if (res.status !== 200 || !res.json?.access_token) {
    throw new Error(`gigachat_auth_failed:${res.status}`);
  }
  cachedToken = {
    token: res.json.access_token,
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return cachedToken.token;
}

const GIGACHAT_SYSTEM_PROMPT = 'Ты — маркетолог студии STIMIT. Пиши продающие посты для Telegram и VK: живой тон, структура, призыв к действию. До 900 знаков. Не выдумывай цифры и факты.';

export async function generateWithGigachat(task, systemPrompt = GIGACHAT_SYSTEM_PROMPT) {
  const token = await getGigachatToken();
  const res = await httpsPostJson(GIGACHAT_CHAT_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: 'GigaChat',
      max_tokens: 1500,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ],
    },
    timeoutMs: 30000,
  });
  if (res.status !== 200) throw new Error(`gigachat_api_error:${res.status}`);
  const text = res.json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('gigachat_empty_response');
  return text;
}
