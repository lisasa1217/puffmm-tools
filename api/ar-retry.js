// 補發排程：Supabase pg_cron 每 5 分鐘呼叫一次，把到期的補發送出去
// 不需要密碼：只會處理佇列裡「已經到時間」的項目，多呼叫幾次也不會重複傳
const { processQueue } = require('../lib/ar');

module.exports = async (req, res) => {
  try {
    res.json(await processQueue(40));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
