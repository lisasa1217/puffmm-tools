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
  if (j.error) {
    const e = new Error(j.error.message || 'IG API 錯誤');
    e.code = j.error.code; e.sub = j.error.error_subcode; e.transient = !!j.error.is_transient;
    throw e;
  }
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
      // 直接開啟：不經過 pufftool 轉址（少一層轉址，但算不到點擊）
      if (b.direct) return { type: 'web_url', url: b.url, title: b.title.slice(0, 20) };
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

// ---- 補發佇列 ----
// IG 暫時性的錯誤（發太快、系統忙）才重試；封鎖、找不到對象這類重試也沒用
function isRetryable(e) {
  if (!e) return false;
  if (e.transient) return true;
  if ([1, 2, 4, 17, 32, 613, 80002, 80006].includes(e.code)) return true;
  return /limit|too many|temporar|try again|timeout|fetch failed|ECONN/i.test(e.message || '');
}
const BACKOFF_MIN = [5, 10, 20, 40, 60, 120, 240, 480];   // 第幾次重試要等幾分鐘，最多 8 次（約 16 小時）

async function enqueue(item) {
  try {
    await db('ar_queue', { method: 'POST', body: { ...item, next_at: new Date(Date.now() + BACKOFF_MIN[0] * 6e4).toISOString() } });
  } catch (e) { console.error('enqueue', e.message); }
}

// 送一筆佇列裡的東西
async function deliver(q, token) {
  const p = q.payload || {};
  if (q.kind === 'public_reply') return ig(`/${p.comment_id}/replies`, { method: 'POST', body: { message: p.message }, token });
  for (const message of p.messages || []) await ig('/me/messages', { method: 'POST', body: { recipient: p.recipient, message }, token });
}

// 處理到期的補發（一次最多 limit 筆）；回傳處理結果數量
async function processQueue(limit = 20, token) {
  token = token || await getToken();
  const due = await db(`ar_queue?status=eq.pending&next_at=lte.${new Date().toISOString()}&order=next_at&limit=${limit}&select=*`);
  let ok = 0, fail = 0;
  for (const q of due) {
    // 先搶到這筆（避免兩個程式同時補發同一筆）
    const got = await db(`ar_queue?id=eq.${q.id}&status=eq.pending`, { method: 'PATCH', body: { status: 'sending' }, prefer: 'return=representation' });
    if (!got.length) continue;
    const base = { rule_id: q.rule_id, user_id: q.user_id, username: q.username, trigger: 'retry' };
    try {
      await deliver(q, token);
      await db(`ar_queue?id=eq.${q.id}`, { method: 'PATCH', body: { status: 'sent', attempts: q.attempts + 1, done_at: new Date().toISOString(), last_error: null } });
      await logEvent({ ...base, kind: q.kind === 'public_reply' ? 'public_reply' : 'dm', detail: '（補發成功）' + (q.payload?.label || '') });
      ok++;
    } catch (e) {
      const n = q.attempts + 1;
      const tooOld = Date.now() - new Date(q.created_at) > 23 * 36e5;   // 私訊超過 24 小時就不能傳了
      const giveUp = !isRetryable(e) || n >= BACKOFF_MIN.length || tooOld;
      await db(`ar_queue?id=eq.${q.id}`, { method: 'PATCH', body: {
        status: giveUp ? 'failed' : 'pending', attempts: n, last_error: e.message.slice(0, 300),
        next_at: new Date(Date.now() + BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length - 1)] * 6e4).toISOString(),
        done_at: giveUp ? new Date().toISOString() : null,
      } });
      if (giveUp) await logEvent({ ...base, kind: 'error', detail: '補發放棄：' + e.message.slice(0, 150) });
      fail++;
    }
  }
  return { due: due.length, ok, fail };
}

module.exports = { db, ig, getToken, matchKeyword, buildMessages, sendTo, logEvent, SITE, isRetryable, enqueue, processQueue };
