// 自動回覆系統共用：Supabase、IG 發送、關鍵字比對
// 環境變數：SUPABASE_SERVICE_KEY（必要）、IG_TOKEN、IG_APP_SECRET、AR_VERIFY_TOKEN、AR_ADMIN_PASS
const { pinyin } = require('pinyin-pro');

const SUPABASE_URL = 'https://nkoclwpfugtaepwpgnwl.supabase.co';
const GRAPH = 'https://graph.instagram.com/v23.0';
const SITE = 'https://pufftool.vercel.app';

async function db(path, { method = 'GET', body, prefer } = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && (data.message || data.hint)) || `DB ${r.status}`);
  return data;
}

async function getToken() {
  try {
    const rows = await db('app_secrets?key=eq.ig_token&select=value');
    if (rows[0]?.value) return rows[0].value;
  } catch (e) { /* 表不存在就用環境變數 */ }
  return process.env.IG_TOKEN || '';
}

// 呼叫 IG API（錯誤訊息不帶 token）
async function ig(path, { method = 'GET', body, token } = {}) {
  token = token || await getToken();
  const url = `${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'IG API 錯誤');
  return j;
}

// ---- 關鍵字比對：包含就算；拼音相同也算（新先 = 新鮮） ----
function norm(t) { return String(t || '').toLowerCase().replace(/[\s　.,!?！？。，、~～'"「」()（）\-_*#@:：;；]/g, ''); }
function py(t) { return pinyin(norm(t), { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('|'); }
function matchKeyword(text, keywords, fuzzy = true) {
  const n = norm(text);
  if (!n) return null;
  for (const k of keywords || []) {
    const nk = norm(k);
    if (!nk) continue;
    if (n.includes(nk)) return k;
    if (fuzzy && /[一-鿿]/.test(nk) && `|${py(text)}|`.includes(`|${py(k)}|`)) return k;
  }
  return null;
}

// ---- 訊息組裝 ----
// 範本 → IG 訊息（可能兩則：先圖片、再文字＋按鈕）
function buildMessages(tpl, ctx) {
  const out = [];
  if (tpl.image_url) out.push({ attachment: { type: 'image', payload: { url: tpl.image_url } } });
  const buttons = (tpl.buttons || []).slice(0, 3).map((b, i) => {
    if (b.type === 'url') {
      const go = `${SITE}/api/ar-go?t=${tpl.id}&b=${i}&r=${ctx.ruleId || ''}&u=${encodeURIComponent(ctx.userId || '')}`;
      return { type: 'web_url', url: go, title: b.title.slice(0, 20) };
    }
    // next：傳下一則範本；gate：先查追蹤再傳
    return { type: 'postback', title: b.title.slice(0, 20), payload: JSON.stringify({ k: b.type, m: b.next, r: ctx.ruleId || null, f: b.fail || null }) };
  });
  const text = (tpl.text || '').trim();
  if (buttons.length) {
    out.push({ attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640) || '👇', buttons } } });
  } else if (text) {
    out.push({ text: text.slice(0, 1000) });
  }
  return out;
}

async function sendTo(recipient, messages, token) {
  for (const message of messages) {
    await ig('/me/messages', { method: 'POST', body: { recipient, message }, token });
  }
}

async function logEvent(ev) {
  try { await db('ar_events', { method: 'POST', body: ev }); } catch (e) { console.error('log', e.message); }
}

module.exports = { db, ig, getToken, matchKeyword, buildMessages, sendTo, logEvent, SITE };
