const TG_API = 'https://api.telegram.org';

export const ALLOWED_TARGETS = [
  'https://t.me/stimit_ai_marketer_demo',
  'https://vk.ru/stimit_ai_marketer_demo',
];

function chatIdFromTarget(target) {
  const m = target.match(/^https?:\/\/t\.me\/([\w]+)/);
  return m ? '@' + m[1] : null;
}

export async function publishTelegram(target, text, imageUrl) {
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
    if (!data.ok) {
      console.log(`publish TG ERROR: ${data.description || 'unknown'}`);
      throw new Error('telegram_api_error');
    }
    console.log('publish TG OK');
    return { id: data.result?.message_id };
  }
  const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  });
  const data = await r.json();
  if (!data.ok) {
    console.log(`publish TG ERROR: ${data.description || 'unknown'}`);
    throw new Error('telegram_api_error');
  }
  console.log('publish TG OK');
  return { id: data.result?.message_id };
}
