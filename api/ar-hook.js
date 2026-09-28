// IG Webhook：留言、限動回覆、私訊、按鈕 → 依規則自動回覆
const crypto = require('crypto');
const { db, ig, getToken, matchKeyword, buildMessages, sendTo, logEvent } = require('../lib/ar');

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

async function rulesFor(trigger) {
  return db(`ar_rules?active=eq.true&trigger=eq.${trigger}&select=*&order=id`);
}
async function template(id) {
  if (!id) return null;
  const rows = await db(`ar_templates?id=eq.${id}&select=*`);
  return rows[0] || null;
}

// 同一規則對同一人：留言只回一次；限動/私訊依冷卻時間（預設 24 小時）
async function claim(rule, userId) {
  const rows = await db(`ar_sent?rule_id=eq.${rule.id}&user_id=eq.${userId}&select=sent_at`);
  if (rows[0]) {
    const hrs = rule.trigger === 'comment' ? Infinity : (rule.cooldown_hours ?? 24);
    if ((Date.now() - new Date(rows[0].sent_at)) / 36e5 < hrs) return false;
    await db(`ar_sent?rule_id=eq.${rule.id}&user_id=eq.${userId}`, { method: 'PATCH', body: { sent_at: new Date().toISOString() } });
    return true;
  }
  const ins = await db('ar_sent', { method: 'POST', body: { rule_id: rule.id, user_id: userId }, prefer: 'resolution=ignore-duplicates,return=representation' });
  return ins.length > 0;
}

// 同一篇／同一則限動：指定的規則優先，再看「全部適用」的規則
function firstMatch(rules, mediaId, text) {
  const ordered = [...rules.filter(r => r.media_id && r.media_id === mediaId), ...rules.filter(r => !r.media_id)];
  for (const r of ordered) {
    const kw = matchKeyword(text, r.keywords, r.fuzzy !== false);
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
  if (!(await claim(rule, v.from.id))) return logEvent({ ...base, kind: 'dup' });
  await logEvent({ ...base, kind: 'trigger', keyword: kw });

  // 公開回覆（從回覆庫隨機挑）
  if (rule.public_reply_ids?.length) {
    try {
      const rows = await db(`ar_public_replies?id=in.(${rule.public_reply_ids.join(',')})&select=text`);
      if (rows.length) {
        const msg = pick(rows).text.replace(/\{name\}/g, '@' + v.from.username);
        await ig(`/${v.id}/replies`, { method: 'POST', body: { message: msg }, token });
        await logEvent({ ...base, kind: 'public_reply', detail: msg });
      }
    } catch (e) { await logEvent({ ...base, kind: 'error', detail: '公開回覆失敗：' + e.message }); }
  }

  // 私訊（IG 規定：每則留言只能私訊一次 → 只送一則，圖片略過）
  const tpl = await template(rule.first_template_id);
  if (!tpl) return;
  try {
    const msgs = buildMessages({ ...tpl, image_url: null }, { ruleId: rule.id, userId: v.from.id });
    await ig('/me/messages', { method: 'POST', body: { recipient: { comment_id: v.id }, message: msgs[msgs.length - 1] }, token });
    await logEvent({ ...base, kind: 'dm', detail: tpl.name });
  } catch (e) { await logEvent({ ...base, kind: 'error', detail: '私訊失敗：' + e.message }); }
}

async function username(id, token) {
  try { return (await ig(`/${id}?fields=username`, { token })).username; } catch (e) { return null; }
}

async function sendTemplate(userId, tplId, ruleId, token, base) {
  const tpl = await template(tplId);
  if (!tpl) return;
  try {
    await sendTo({ id: userId }, buildMessages(tpl, { ruleId, userId }), token);
    await logEvent({ ...base, kind: 'dm', detail: tpl.name });
  } catch (e) { await logEvent({ ...base, kind: 'error', detail: '私訊失敗：' + e.message }); }
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
      if (follows) return sendTemplate(uid, p.m, p.r, token, base);
      if (p.f) return sendTemplate(uid, p.f, p.r, token, base);
      // 沒設「沒追蹤」範本時的預設回覆：同一顆按鈕再給一次
      await sendTo({ id: uid }, [{ attachment: { type: 'template', payload: {
        template_type: 'button', text: '還沒追蹤芙媽喔 🥺\n追蹤 @puff.andmom 之後，再按一次下面的按鈕就給你！',
        buttons: [{ type: 'postback', title: '我追蹤好了！', payload: m.postback.payload }],
      } } }], token);
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
  res.status(200).send('ok');
};
