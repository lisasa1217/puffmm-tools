// 私訊裡的連結按鈕：先記一筆點擊，再轉到真正的網址
const { db, logEvent } = require('../lib/ar');

module.exports = async (req, res) => {
  const { t, b, r, u } = req.query;
  let url = 'https://www.instagram.com/puff.andmom/';
  try {
    const rows = await db(`ar_templates?id=eq.${parseInt(t, 10)}&select=name,buttons`);
    const btn = rows[0]?.buttons?.[parseInt(b, 10)];
    if (btn?.url && /^https?:\/\//.test(btn.url)) url = btn.url;
    await logEvent({ rule_id: parseInt(r, 10) || null, user_id: u || null, trigger: 'click', kind: 'click', detail: `${rows[0]?.name || ''}｜${btn?.title || ''}` });
  } catch (e) { /* 紀錄失敗也照樣轉址 */ }
  res.writeHead(302, { Location: url });
  res.end();
};
