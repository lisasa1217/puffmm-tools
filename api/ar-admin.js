// 自動回覆後台 API（要帶 x-pass = AR_ADMIN_PASS）
const { db, ig, processQueue } = require('../lib/ar');

const TABLES = {
  ar_rules: ['name', 'trigger', 'media_id', 'media_label', 'media_thumb', 'keywords', 'fuzzy', 'public_reply_ids', 'first_template_id', 'cooldown_hours', 'active', 'any_text', 'starts_at', 'ends_at'],
  ar_templates: ['name', 'text', 'image_url', 'buttons'],
  ar_public_replies: ['text'],
};

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise(resolve => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
}

module.exports = async (req, res) => {
  const pass = process.env.AR_ADMIN_PASS;
  if (!pass || req.headers['x-pass'] !== pass) return res.status(401).json({ error: 'need_pass' });
  if (!process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: '還沒設定 SUPABASE_SERVICE_KEY' });
  const action = req.query.action;
  try {
    if (action === 'all') {
      const [rules, templates, replies] = await Promise.all([
        db('ar_rules?select=*&order=id.desc'),
        db('ar_templates?select=*&order=id.desc'),
        db('ar_public_replies?select=*&order=id'),
      ]);
      return res.json({ rules, templates, replies });
    }

    if (action === 'save' || action === 'delete') {
      const { table, row, id } = await readJson(req);
      if (!TABLES[table]) return res.status(400).json({ error: '不能改這張表' });
      if (action === 'delete') {
        await db(`${table}?id=eq.${parseInt(id, 10)}`, { method: 'DELETE' });
        return res.json({ ok: true });
      }
      const clean = {};
      for (const k of TABLES[table]) if (k in row) clean[k] = row[k];
      const out = row.id
        ? await db(`${table}?id=eq.${parseInt(row.id, 10)}`, { method: 'PATCH', body: clean, prefer: 'return=representation' })
        : await db(table, { method: 'POST', body: clean, prefer: 'return=representation' });
      return res.json({ row: out[0] });
    }

    if (action === 'events') {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const [rows, queue] = await Promise.all([
        db(`ar_events?select=*&created_at=gte.${since}&order=id.desc&limit=5000`),
        db(`ar_queue?select=id,created_at,rule_id,user_id,username,kind,status,attempts,next_at,last_error,done_at,payload->>label&created_at=gte.${since}&order=id.desc&limit=500`),
      ]);
      return res.json({ events: rows, queue });
    }

    // 補發：指定一筆或全部「等待中／失敗」的，立刻再試
    if (action === 'retry') {
      const { id } = await readJson(req);
      const filter = id ? `id=eq.${parseInt(id, 10)}` : 'status=in.(pending,failed)';
      await db(`ar_queue?${filter}&status=neq.sent`, { method: 'PATCH', body: { status: 'pending', next_at: new Date().toISOString() } });
      return res.json(await processQueue(id ? 1 : 40));
    }

    if (action === 'posts') {
      const j = await ig('/me/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,comments_count&limit=40');
      return res.json({ items: (j.data || []).map(p => ({ id: p.id, label: (p.caption || '').split('\n')[0].slice(0, 40), thumb: p.thumbnail_url || p.media_url, time: p.timestamp })) });
    }

    if (action === 'stories') {
      const j = await ig('/me/stories?fields=id,media_type,media_url,thumbnail_url,timestamp');
      return res.json({ items: (j.data || []).map(p => ({ id: p.id, label: '限動 ' + new Date(p.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), thumb: p.thumbnail_url || p.media_url, time: p.timestamp })) });
    }

    return res.status(400).json({ error: '未知的 action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
