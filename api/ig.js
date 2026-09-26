// 抽獎工具用的 IG API 中介（Vercel serverless function）
// token 只放在伺服器端，網頁拿不到。
//
// 需要的環境變數（Vercel → Settings → Environment Variables）：
//   IG_TOKEN              IG 長效 token（Instagram API with Instagram Login）
//   LOTTERY_PASS          （選填）抽獎頁的通關密碼，沒設就不檢查
//   SUPABASE_SERVICE_KEY  （選填）有設的話 token 改存在 Supabase app_secrets 表，
//                         每週排程自動續期、不用每 60 天手動換
//   CRON_SECRET           （選填）Vercel 排程呼叫 refresh 時帶的密鑰
//
// action：
//   status   → 有沒有設定好、帳號名稱
//   posts    → 最近的貼文（含留言數）
//   comments → 某篇貼文的全部留言（media=ID）
//   history  → 最近 N 篇貼文各有哪些人留過言（給「可疑抽獎帳」判斷用）
//   refresh  → 續期 token（排程用）

const GRAPH = 'https://graph.instagram.com/v23.0';
const SUPABASE_URL = 'https://nkoclwpfugtaepwpgnwl.supabase.co';

async function getToken() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (key) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/app_secrets?key=eq.ig_token&select=value`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0]?.value) return rows[0].value;
    } catch (e) { /* 退回用環境變數 */ }
  }
  return process.env.IG_TOKEN || '';
}

async function saveToken(token) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_secrets`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: 'ig_token', value: token, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

async function ig(path, token) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'IG API 錯誤');
  return j;
}

// 跟著 paging.next 一直抓到底
async function igRetry(path, token) {
  try { return await ig(path, token); }
  catch (e) { await new Promise(r => setTimeout(r, 800)); return ig(path, token); }
}
async function igAll(path, token, max = 20000) {
  let out = [];
  let j = await igRetry(path, token);
  out = out.concat(j.data || []);
  while (j.paging?.next && out.length < max) {
    j = await igRetry(j.paging.next, token);
    out = out.concat(j.data || []);
  }
  return out;
}

const GIVEAWAY_RE = /抽獎|抽出|抽\s*\d|送出|贈送|送給|giveaway|留言.*tag|tag.*朋友|標記.*朋友/i;

module.exports = async (req, res) => {
  const action = req.query.action || 'status';

  if (action === 'refresh') {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
    try {
      const token = await getToken();
      const j = await ig(`/refresh_access_token?grant_type=ig_refresh_token`, token);
      const saved = await saveToken(j.access_token);
      return res.json({ ok: true, saved, expires_in_days: Math.round((j.expires_in || 0) / 86400) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const pass = process.env.LOTTERY_PASS;
  if (pass && req.headers['x-pass'] !== pass) return res.status(401).json({ error: 'need_pass' });

  const token = await getToken();
  if (!token) return res.json({ configured: false });

  try {
    if (action === 'status') {
      const me = await ig('/me?fields=user_id,username', token);
      return res.json({ configured: true, username: me.username });
    }

    if (action === 'posts') {
      const posts = await igAll('/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=50', token, 60);
      return res.json({
        posts: posts.map(p => ({
          id: p.id,
          caption: p.caption || '',
          thumb: p.thumbnail_url || p.media_url || '',
          permalink: p.permalink,
          timestamp: p.timestamp,
          comments: p.comments_count || 0,
          giveaway: GIVEAWAY_RE.test(p.caption || ''),
        })),
      });
    }

    if (action === 'comments') {
      const media = req.query.media;
      if (!/^\d+$/.test(media || '')) return res.status(400).json({ error: '缺少貼文 ID' });
      // IG 分頁偶爾會提早結束 → 跟貼文留言數比，少太多就重抓（最多 3 次，取最多的那次）
      const { comments_count: total = 0 } = await ig(`/${media}?fields=comments_count`, token);
      let list = [];
      for (let t = 0; t < 3; t++) {
        const got = await igAll(`/${media}/comments?fields=id,text,timestamp,username,from&limit=50`, token);
        if (got.length > list.length) list = got;
        if (list.length >= total * 0.9) break;
      }
      return res.json({
        comments: list.map(c => ({ id: c.id, username: c.username || c.from?.username, text: c.text || '', timestamp: c.timestamp })),
        total,
      });
    }

    if (action === 'history') {
      const n = Math.min(parseInt(req.query.n || '40', 10), 60);
      const exclude = req.query.exclude || '';
      const posts = (await igAll('/me/media?fields=id,caption,timestamp,comments_count&limit=50', token, n)).slice(0, n)
        .filter(p => p.id !== exclude);
      // 每個人：在幾篇一般貼文留過言、參加過幾次抽獎
      const users = {};
      const errors = [];
      let i = 0;
      async function worker() {
        while (i < posts.length) {
          const p = posts[i++];
          const giveaway = GIVEAWAY_RE.test(p.caption || '');
          let names;
          try {
            names = new Set((await igAll(`/${p.id}/comments?fields=id,username,from&limit=50`, token, 6000)).map(c => c.username || c.from?.username).filter(Boolean));
          } catch (e) { errors.push(e.message); continue; }
          for (const u of names) {
            users[u] = users[u] || { normal: 0, giveaway: 0 };
            users[u][giveaway ? 'giveaway' : 'normal']++;
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      return res.json({
        scanned: posts.length,
        giveawayPosts: posts.filter(p => GIVEAWAY_RE.test(p.caption || '')).length,
        users,
        errors: [...new Set(errors)].slice(0, 3),
      });
    }

    return res.status(400).json({ error: '未知的 action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
