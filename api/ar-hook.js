// IG Webhook：留言、限動回覆、私訊、按鈕 → 依規則自動回覆
const crypto = require('crypto');
const { db, ig, getToken, matchKeyword, buildMessages, sendTo, logEvent, isRetryable, enqueue, processQueue } = require('../lib/ar');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function validSig(raw, header) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return true; // 還沒設密鑰時先放行（設定期間）
  if (!header) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return exp.length === header.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(header));
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// 公開回覆每小時上限（全帳號合計）：留言爆量時，短時間回幾百則很像的留言容易被當成機器人
// Meta 沒公布門檻，60＝約一分鐘一則，保守值；超過的照樣私訊，只是不公開回
const PUBLIC_PER_HOUR = 60;
async function publicQuotaLeft() {
  const since = new Date(Date.now() - 36e5).toISOString();
  const rows = await db(`ar_events?kind=eq.public_reply&created_at=gte.${since}&select=id&limit=${PUBLIC_PER_HOUR}`);
  return rows.length < PUBLIC_PER_HOUR;
}

// 送不出去：IG 暫時性問題就排進補發佇列，其他記成錯誤
async function failed(e, base, item, what) {
  if (isRetryable(e)) {
    await enqueue({ rule_id: base.rule_id, user_id: base.user_id, username: base.username, ...item, last_error: e.message.slice(0, 300) });
    return logEvent({ ...base, kind: 'queued', detail: `${what}排隊補發：${e.message.slice(0, 120)}` });
  }
  return logEvent({ ...base, kind: 'error', detail: `${what}失敗：${e.message}` });
}

async function rulesFor(trigger) {
  const now = Date.now();
  const rows = await db(`ar_rules?active=eq.true&trigger=eq.${trigger}&select=*&order=id`);
  // 還沒開始、已經結束的規則不回
  return rows.filter(r => (!r.starts_at || new Date(r.starts_at) <= now) && (!r.ends_at || new Date(r.ends_at) > now));
}
async function template(id) {
  if (!id) return null;
  const rows = await db(`ar_templates?id=eq.${id}&select=*`);
  return rows[0] || null;
}

// 同一規則對同一人要不要再回：見下面（留言看有沒有互動過；限動/私訊依冷卻時間，預設 1 小時）
async function claim(rule, userId, mediaId) {
  // 留言：同一條規則換了貼文就算新的一次（key 帶貼文 id）；限動／私訊只看人
  const who = rule.trigger === 'comment' && mediaId ? `${userId}@${mediaId}` : userId;
  const rows = await db(`ar_sent?rule_id=eq.${rule.id}&user_id=eq.${encodeURIComponent(who)}&select=sent_at`);
  if (rows[0]) {
    if (rule.trigger === 'comment') {
      // 留言：這篇上次私訊之後，對方按過按鈕／點過連結（有看到）就不再重傳；
      // 完全沒互動的（可能沒看到，私訊躺在「訊息請求」）再留言時可以重傳，但至少隔 10 分鐘
      const since = new Date(rows[0].sent_at).toISOString();
      const evs = await db(`ar_events?rule_id=eq.${rule.id}&user_id=eq.${userId}&kind=in.(button,click)&created_at=gte.${since}&select=kind`);
      if (evs.length) return false;
      if ((Date.now() - new Date(rows[0].sent_at)) / 6e4 < 10) return false;
    } else {
      const hrs = rule.cooldown_hours ?? 1;
      if ((Date.now() - new Date(rows[0].sent_at)) / 36e5 < hrs) return false;
    }
    await db(`ar_sent?rule_id=eq.${rule.id}&user_id=eq.${encodeURIComponent(who)}`, { method: 'PATCH', body: { sent_at: new Date().toISOString() } });
    return true;
  }
  const ins = await db('ar_sent', { method: 'POST', body: { rule_id: rule.id, user_id: who }, prefer: 'resolution=ignore-duplicates,return=representation' });
  return ins.length > 0;
}

// 同一篇／同一則限動：指定的規則優先，再看「全部適用」的規則
function firstMatch(rules, mediaId, text) {
  const ordered = [...rules.filter(r => r.media_id && r.media_id === mediaId), ...rules.filter(r => !r.media_id)];
  for (const r of ordered) {
    const kw = r.any_text ? (String(text || '').trim() ? '（任何內容）' : null) : matchKeyword(text, r.keywords, r.fuzzy !== false);
    if (kw) return { rule: r, kw };
  }
  return null;
}

async function onComment(v, ownerId, token) {
  if (!v || !v.from || v.from.id === ownerId || v.parent_id) return; // 自己的留言、留言串裡的回覆不處理
  const hit = firstMatch(await rulesFor('comment'), v.media?.id, v.text);
  if (!hit) return;
  const { rule, kw } = hit;
  const base = { rule_id: rule.id, user_id: v.from.id, username: v.from.username, trigger: 'comment', detail: v.text?.slice(0, 200) };
  if (!(await claim(rule, v.from.id, v.media?.id))) return logEvent({ ...base, kind: 'dup' });
  await logEvent({ ...base, kind: 'trigger', keyword: kw });

  // 公開回覆（從回覆庫隨機挑）
  if (rule.public_reply_ids?.length && !(await publicQuotaLeft())) {
    await logEvent({ ...base, kind: 'public_skip', detail: `這小時已公開回覆 ${PUBLIC_PER_HOUR} 則，這則只私訊` });
  } else if (rule.public_reply_ids?.length) {
    let msg = null;
    try {
      const rows = await db(`ar_public_replies?id=in.(${rule.public_reply_ids.join(',')})&select=text`);
      if (rows.length) {
        msg = pick(rows).text.replace(/\{name\}/g, '@' + v.from.username);
        await ig(`/${v.id}/replies`, { method: 'POST', body: { message: msg }, token });
        await logEvent({ ...base, kind: 'public_reply', detail: msg });
      }
    } catch (e) {
      await failed(e, base, { kind: 'public_reply', payload: { comment_id: v.id, message: msg, label: '公開回覆' } }, '公開回覆');
    }
  }

  // 私訊（IG 規定：每則留言只能私訊一次 → 只送一則，圖片略過）
  const tpl = await template(rule.first_template_id);
  if (!tpl) return;
  const msgs = buildMessages({ ...tpl, image_url: null }, { ruleId: rule.id, userId: v.from.id });
  const message = msgs[msgs.length - 1];
  try {
    await ig('/me/messages', { method: 'POST', body: { recipient: { comment_id: v.id }, message }, token });
    await logEvent({ ...base, kind: 'dm', detail: tpl.name });
  } catch (e) {
    await failed(e, base, { kind: 'comment_dm', payload: { recipient: { comment_id: v.id }, messages: [message], label: tpl.name } }, '私訊');
  }
}

async function username(id, token) {
  try { return (await ig(`/${id}?fields=username`, { token })).username; } catch (e) { return null; }
}

async function sendTemplate(userId, tplId, ruleId, token, base, opt = {}) {
  let tpl = await template(tplId);
  if (!tpl) return;
  if (opt.noButtons) tpl = { ...tpl, buttons: [] };
  const msgs = buildMessages(tpl, { ruleId, userId });
  try {
    await sendTo({ id: userId }, msgs, token);
    await logEvent({ ...base, kind: 'dm', detail: tpl.name });
  } catch (e) {
    await failed(e, base, { kind: 'dm', payload: { recipient: { id: userId }, messages: msgs, label: tpl.name } }, '私訊');
  }
}

async function onMessage(m, ownerId, token) {
  const uid = m.sender?.id;
  if (!uid || uid === ownerId || m.message?.is_echo) return;

  // 按鈕
  if (m.postback?.payload) {
    let p; try { p = JSON.parse(m.postback.payload); } catch (e) { return; }
    const base = { rule_id: p.r, user_id: uid, username: await username(uid, token), trigger: 'button', detail: m.postback.title };
    await logEvent({ ...base, kind: 'button' });
    if (p.k === 'gate') {
      let follows = false;
      try { follows = !!(await ig(`/${uid}?fields=is_user_follow_business`, { token })).is_user_follow_business; } catch (e) { /* 查不到當作沒追蹤 */ }
      await logEvent({ ...base, kind: follows ? 'follow_yes' : 'follow_no' });
      // Meta 社群守則禁止「要追蹤才能拿到內容」→ 一律給連結；沒追蹤的人後面多一句邀請追蹤（不附按鈕）
      await sendTemplate(uid, p.m, p.r, token, base);
      if (!follows && p.f) await sendTemplate(uid, p.f, p.r, token, base, { noButtons: true });
      return;
    }
    if (p.k === 'next') return sendTemplate(uid, p.m, p.r, token, base);
    return;
  }

  const text = m.message?.text;
  if (!text) return;
  const story = m.message.reply_to?.story;
  const trigger = story ? 'story' : 'dm';
  const hit = firstMatch(await rulesFor(trigger), story?.id, text);
  if (!hit) return;
  const { rule, kw } = hit;
  const base = { rule_id: rule.id, user_id: uid, username: await username(uid, token), trigger, detail: text.slice(0, 200) };
  if (!(await claim(rule, uid))) return logEvent({ ...base, kind: 'dup' });
  await logEvent({ ...base, kind: 'trigger', keyword: kw });
  await sendTemplate(uid, rule.first_template_id, rule.id, token, base);
}

module.exports = async (req, res) => {
  // Meta 驗證 webhook 網址
  if (req.method === 'GET') {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === process.env.AR_VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('forbidden');
  }
  const raw = await readRaw(req);
  if (!validSig(raw, req.headers['x-hub-signature-256'])) return res.status(401).send('bad signature');
  let body; try { body = JSON.parse(raw); } catch (e) { return res.status(400).send('bad json'); }

  const token = await getToken();
  const jobs = [];
  for (const entry of body.entry || []) {
    const ownerId = String(entry.id);
    for (const c of entry.changes || []) {
      if (c.field === 'comments') jobs.push(onComment(c.value, ownerId, token));
    }
    for (const m of entry.messaging || []) jobs.push(onMessage(m, ownerId, token));
  }
  await Promise.allSettled(jobs);
  try { await processQueue(3, token); } catch (e) { /* 補發失敗不影響回應 */ }
  res.status(200).send('ok');
};
