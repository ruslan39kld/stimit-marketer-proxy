import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const VK_OWNER_ID = -243694741;
const VK_API_VERSION = '5.199';
const VK_API = 'https://api.vk.ru/method';

const VK_TOKEN_FILE = '/data/vk_token.json';
const VK_CLIENT_ID = process.env.VK_CLIENT_ID || '';

export const vkToken = { access_token: '', refresh_token: '', expires_at: 0, device_id: '' };

export function tokenDesc(token) {
  if (!token) return 'set=no len=0 head=- tail=-';
  return `set=yes len=${token.length} head=${token.slice(0, 4)} tail=${token.slice(-4)}`;
}

function tokenMask(token) {
  if (!token) return '-';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export function loadVkToken() {
  try {
    if (fs.existsSync(VK_TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(VK_TOKEN_FILE, 'utf8'));
      vkToken.access_token = data.access_token || '';
      vkToken.refresh_token = data.refresh_token || '';
      vkToken.expires_at = Number(data.expires_at) || 0;
      vkToken.device_id = data.device_id || '';
      console.log(`vk token loaded from file: ${tokenMask(vkToken.access_token)}`);
      return;
    }
  } catch (e) {
    console.log(`vk token file read ERROR: ${e.message}`);
  }
  vkToken.access_token = process.env.VK_ACCESS_TOKEN || '';
  vkToken.refresh_token = process.env.VK_REFRESH_TOKEN || '';
  vkToken.device_id = process.env.VK_DEVICE_ID || '';
  vkToken.expires_at = Date.now() + 50 * 60 * 1000;
}

function saveVkToken() {
  try {
    fs.mkdirSync(path.dirname(VK_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(VK_TOKEN_FILE, JSON.stringify(vkToken, null, 2));
  } catch (e) {
    console.log(`vk token file save ERROR: ${e.message}`);
  }
}

function refreshVkToken() {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: VK_CLIENT_ID,
      device_id: vkToken.device_id,
      refresh_token: vkToken.refresh_token,
      state: 'stimit',
    }).toString();
    const req = https.request({
      hostname: 'id.vk.com',
      path: '/oauth2/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            vkToken.access_token = json.access_token;
            vkToken.refresh_token = json.refresh_token || vkToken.refresh_token;
            vkToken.device_id = json.device_id || vkToken.device_id;
            vkToken.expires_at = Date.now() + Number(json.expires_in || 3600) * 1000;
            saveVkToken();
            console.log(`vk refresh OK: token ${tokenMask(vkToken.access_token)}`);
            resolve(true);
          } else {
            console.log(`vk refresh ERROR ${json.error || 'unknown'}${json.error_description ? ` ${json.error_description}` : ''}`);
            resolve(false);
          }
        } catch (e) {
          console.log(`vk refresh ERROR ${e.message}`);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.log(`vk refresh ERROR ${e.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function ensureVkToken() {
  if (!vkToken.access_token && !vkToken.refresh_token) throw new Error('vk_not_configured');
  if (vkToken.refresh_token && vkToken.expires_at - Date.now() < 5 * 60 * 1000) {
    await refreshVkToken();
  }
  if (!vkToken.access_token) throw new Error('vk_not_configured');
  return vkToken.access_token;
}

async function vkCall(method, params) {
  const token = await ensureVkToken();
  const qs = new URLSearchParams({
    ...params,
    v: VK_API_VERSION,
  }).toString();
  const r = await fetch(`${VK_API}/${method}?${qs}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await r.json();
  if (data.error) {
    console.log(`publish VK ERROR ${method}: code=${data.error.error_code} ${data.error.error_msg || 'unknown'} token=${tokenMask(token)}`);
    throw new Error(`vk_api_error_${data.error.error_code}`);
  }
  console.log(`publish VK OK: ${method}`);
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
  if (uploaded.error) {
    console.log(`publish VK ERROR: ${uploaded.error.error_msg || 'unknown'} (code ${uploaded.error.error_code})`);
  }
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

export async function publishVk(text, imageUrl) {
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

export async function vkSelfTest() {
  try {
    const token = await ensureVkToken();
    const r = await fetch(`${VK_API}/users.get?v=${VK_API_VERSION}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await r.json();
    if (data.error) {
      console.log(`vk selftest: code=${data.error.error_code} ${data.error.error_msg || 'unknown'}`);
    } else {
      console.log('vk selftest: OK');
    }
  } catch (e) {
    console.log(`vk selftest: ${e.message}`);
  }
}
