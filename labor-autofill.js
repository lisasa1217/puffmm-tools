/* ==========================================================
   勞報單自動填入（2026-10-02 新增；還原暗號「西瓜」＝ git tag xigua-baseline）
   ----------------------------------------------------------
   做法：不靠 AI、不上傳，全部在瀏覽器裡算。
   1. 把每一頁畫成圖，從「像素」找出表格的橫線、直線（含底線 ____）
   2. 拿到每個字的位置（PDF 用 pdf.js 文字層；Word / Excel 在轉檔時
      直接從排版好的 DOM 量每個字的位置，存在 docLayers）
   3. 找到「姓名」「身分證字號」這類標籤 → 判斷要填在
        A. 同一格、標籤右邊（有冒號或底線）
        B. 右邊那一格（表格：標籤 | 空格）
        C. 下面那一格（表頭在上、資料在下）
      並處理：一字一格的小方格、「  年  月  日」這種挖空日期、
      簽名／印章／身分證／存摺圖片的黏貼格
   4. 產生跟手動放置一樣的 placement，使用者可以再拖曳、刪除

   座標：分析時用 S 倍的畫布像素；輸出時轉成 0~1 的比例（nx, ny）。
   文字 placement：anchor 'left' = nx 是文字左緣；沒有 anchor = 置中；
                   pitch 有值 = 一字一格，nx 是第一格中心、pitch 是格距。
   ========================================================== */
window.LaborAutofill = (function () {
  'use strict';
  var S = 2;
  var FONT = "'PingFang TC','Noto Sans TC',sans-serif";
  var mcv = document.createElement('canvas');
  var mctx = mcv.getContext('2d');

  var FILLER = /[\s_＿﹍﹎‗﹏￣ 　]/;
  var CJK = /[一-鿿]/;
  function isFiller(ch) { return FILLER.test(ch); }

  /* ── 1. 頁面分析：線條遮罩 + 字元 ─────────────────────── */
  async function analyzePage(page, layerChars) {
    var vp = page.getViewport({ scale: S });
    var w = Math.round(vp.width), h = Math.round(vp.height);
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var img = ctx.getImageData(0, 0, w, h).data;

    var dark = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < dark.length; i++, p += 4) {
      var l = img[p] * 0.299 + img[p + 1] * 0.587 + img[p + 2] * 0.114;
      dark[i] = l < 200 ? 1 : 0;
    }

    // 字元
    var chars = [];
    if (layerChars && layerChars.length) {
      layerChars.forEach(function (c) {
        var fs = c.fs * h;
        chars.push({ ch: c.ch, x0: c.x0 * w, x1: c.x1 * w, cy: c.cy * h, y0: c.cy * h - fs / 2, y1: c.cy * h + fs / 2, h: fs });
      });
    } else {
      var tc = await page.getTextContent();
      tc.items.forEach(function (it) {
        if (!it.str) return;
        var tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        if (Math.abs(tx[1]) > 0.05 * Math.abs(tx[0])) return;         // 旋轉的字先不處理
        var fh = Math.hypot(tx[2], tx[3]);
        if (fh < 4) return;
        var x = tx[4], base = tx[5], width = it.width * S;
        var arr = Array.from(it.str);
        mctx.font = fh + 'px ' + FONT;
        var ws = arr.map(function (ch) { return mctx.measureText(ch).width || fh * 0.5; });
        var sum = ws.reduce(function (a, b) { return a + b; }, 0) || 1;
        var k = width > 0 ? width / sum : 1, cx = x;
        arr.forEach(function (ch, j) {
          var cw = ws[j] * k;
          chars.push({ ch: ch, x0: cx, x1: cx + cw, y0: base - fh * 0.88, y1: base + fh * 0.12, cy: base - fh * 0.38, h: fh });
          cx += cw;
        });
      });
    }
    chars.forEach(function (c) {
      // macOS / Pages 轉出的 PDF 常把「戶、身、日、月、行」存成康熙部首字元，要轉回一般的字才比對得到
      var n = c.ch.normalize ? c.ch.normalize('NFKC') : c.ch;
      if (n && Array.from(n).length === 1) c.ch = n;
      c.filler = isFiller(c.ch);
      // 文字層有、但畫面上看不到的字（白色字、隱形的佔位字元）→ 當成空白
      if (!c.filler) {
        var ix0 = Math.max(0, Math.floor(c.x0)), ix1 = Math.min(w - 1, Math.ceil(c.x1)), iy0 = Math.max(0, Math.floor(c.y0)), iy1 = Math.min(h - 1, Math.ceil(c.y1)), ink = 0;
        for (var yy = iy0; yy <= iy1 && ink < 3; yy++) for (var xx = ix0; xx <= ix1; xx++) if (dark[yy * w + xx]) { ink++; if (ink >= 3) break; }
        if (ink < 3) c.filler = true;
      }
    });

    // 橫線 / 直線遮罩：夠長、而且是「細」的（不是整塊底色）
    var H = new Uint8Array(w * h), V = new Uint8Array(w * h);
    var MIN_H = 30, MIN_V = 24, x, y, s;
    for (y = 0; y < h; y++) {
      s = -1;
      for (x = 0; x <= w; x++) {
        var d = x < w && dark[y * w + x];
        if (d && s < 0) s = x;
        else if (!d && s >= 0) {
          if (x - s >= MIN_H) for (var xx = s; xx < x; xx++) {
            var up = y >= 4 ? dark[(y - 4) * w + xx] : 0, dn = y + 4 < h ? dark[(y + 4) * w + xx] : 0;
            if (!(up && dn)) H[y * w + xx] = 1;
          }
          s = -1;
        }
      }
    }
    for (x = 0; x < w; x++) {
      s = -1;
      for (y = 0; y <= h; y++) {
        var d2 = y < h && dark[y * w + x];
        if (d2 && s < 0) s = y;
        else if (!d2 && s >= 0) {
          if (y - s >= MIN_V) for (var yy = s; yy < y; yy++) {
            var lf = x >= 4 ? dark[yy * w + x - 4] : 0, rt = x + 4 < w ? dark[yy * w + x + 4] : 0;
            if (!(lf && rt)) V[yy * w + x] = 1;
          }
          s = -1;
        }
      }
    }
    // 把「字的筆畫」從線條遮罩裡清掉：穿過字的線段如果沒有比字本身長多少，就是筆畫不是格線
    chars.forEach(function (c) {
      if (c.filler) return;
      var x0 = Math.max(0, Math.floor(c.x0) - 1), x1 = Math.min(w - 1, Math.ceil(c.x1) + 1);
      var y0 = Math.max(0, Math.floor(c.y0) - 2), y1 = Math.min(h - 1, Math.ceil(c.y1) + 2);
      var maxV = Math.max(MIN_V, 1.8 * c.h), maxH = Math.max(MIN_H, 1.8 * (c.x1 - c.x0), 1.4 * c.h);
      var ym = Math.round((y0 + y1) / 2), xm = Math.round((x0 + x1) / 2), a, b, t;
      for (var xx = x0; xx <= x1; xx++) {
        for (var yy = y0; yy <= y1; yy++) if (V[yy * w + xx]) {
          a = yy; while (a > 0 && V[(a - 1) * w + xx]) a--;
          b = yy; while (b < h - 1 && V[(b + 1) * w + xx]) b++;
          if (b - a + 1 <= maxV) for (t = a; t <= b; t++) V[t * w + xx] = 0;
          yy = b;
        }
      }
      for (var y2 = y0; y2 <= y1; y2++) {
        for (var x2 = x0; x2 <= x1; x2++) if (H[y2 * w + x2]) {
          a = x2; while (a > 0 && H[y2 * w + a - 1]) a--;
          b = x2; while (b < w - 1 && H[y2 * w + b + 1]) b++;
          if (b - a + 1 <= maxH) for (t = a; t <= b; t++) H[y2 * w + t] = 0;
          x2 = b;
        }
      }
    });

    var P = { w: w, h: h, H: H, V: V, dark: dark, chars: chars };
    P.segs = buildSegments(P);
    return P;
  }

  function vAt(P, x, y) {
    if (x < 0 || x >= P.w) return 0;
    for (var dy = -3; dy <= 3; dy += 3) { var yy = y + dy; if (yy >= 0 && yy < P.h && P.V[yy * P.w + x]) return 1; }
    return 0;
  }
  function hAt(P, x, y) {
    if (y < 0 || y >= P.h) return 0;
    for (var dx = -3; dx <= 3; dx += 3) { var xx = x + dx; if (xx >= 0 && xx < P.w && P.H[y * P.w + xx]) return 1; }
    return 0;
  }
  // 從一個點往四個方向找最近的格線 → 這個點所在的「格子」
  function cellAt(P, px, py) {
    px = Math.max(0, Math.min(P.w - 1, Math.round(px))); py = Math.max(0, Math.min(P.h - 1, Math.round(py)));
    var c = { L: 0, R: P.w - 1, T: 0, B: P.h - 1, cl: false, cr: false, ct: false, cb: false }, x, y;
    for (x = px; x >= 0; x--) if (vAt(P, x, py)) { c.L = x + 1; c.cl = true; break; }
    for (x = px + 1; x < P.w; x++) if (vAt(P, x, py)) { c.R = x - 1; c.cr = true; break; }
    for (y = py; y >= 0; y--) if (hAt(P, px, y)) { c.T = y + 1; c.ct = true; break; }
    for (y = py + 1; y < P.h; y++) if (hAt(P, px, y)) { c.B = y - 1; c.cb = true; break; }
    c.w = c.R - c.L; c.h = c.B - c.T;
    return c;
  }
  // 一塊區域裡有多少「墨水」（扣掉格線）→ 用來判斷那格是不是已經有東西（手寫、簽名圖、掃描字）
  function inkIn(P, L, T, R, B, cap) {
    L = Math.max(0, Math.round(L)); T = Math.max(0, Math.round(T)); R = Math.min(P.w - 1, Math.round(R)); B = Math.min(P.h - 1, Math.round(B));
    var n = 0; cap = cap || 60;
    for (var y = T; y <= B; y++) { var o = y * P.w; for (var x = L; x <= R; x++) if (P.dark[o + x] && !P.H[o + x] && !P.V[o + x]) { if (++n >= cap) return n; } }
    return n;
  }
  var INK_MAX = 25;
  function cellInk(P, r) { return inkIn(P, r.L + 4, r.T + 4, r.R - 4, r.B - 4) > INK_MAX; }
  function skipLineRight(P, x, y) { while (x < P.w && vAt(P, x, y)) x++; return x; }
  function skipLineDown(P, x, y) { while (y < P.h && hAt(P, x, y)) y++; return y; }

  /* ── 2. 把字排成「行」再切成「段」（遇到直線或大空白就切） ── */
  function buildSegments(P) {
    var lines = [];
    var sorted = P.chars.slice().sort(function (a, b) { return a.cy - b.cy || a.x0 - b.x0; });
    sorted.forEach(function (c) {
      var hit = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
        var L = lines[i];
        if (Math.abs(L.cy - c.cy) < 0.45 * Math.min(L.h, c.h)) { hit = L; break; }
      }
      if (!hit) { hit = { cy: c.cy, h: c.h, chars: [] }; lines.push(hit); }
      hit.chars.push(c);
    });
    P.lines = lines;
    var segs = [];
    lines.forEach(function (L) {
      L.chars.sort(function (a, b) { return a.x0 - b.x0; });
      var cur = null, prev = null;
      L.chars.forEach(function (c) {
        if (c.filler) { if (cur) cur.all.push(c); return; }
        var brk = !cur;
        if (cur && prev) {
          if (c.x0 - prev.x1 > 5 * c.h) brk = true;
          else {
            var y = Math.round(c.cy);
            for (var x = Math.ceil(prev.x1); x < Math.floor(c.x0); x++) if (vAt(P, x, y)) { brk = true; break; }
          }
        }
        if (brk) { cur = { idx: [], all: [], cy: L.cy, h: L.h }; segs.push(cur); }
        cur.idx.push(c); cur.all.push(c); prev = c;
      });
    });
    segs.forEach(function (s) { s.sq = s.idx.map(function (c) { return c.ch; }).join(''); s.used = new Array(s.idx.length).fill(false); });
    return segs;
  }

  /* ── 3. 規則 ─────────────────────────────────────────── */
  // 順序＝優先順序（長的、明確的放前面；配到的字會被標記，不會被後面的規則重複配）
  function buildRules(profile, imgs) {
    var bm = (profile.birth || '').match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
    var sigKey = imgs.sig ? 'lbs_sig' : (imgs.stamp ? 'lbs_stamp' : null);
    var tm = (profile.today_roc || '').match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
    var today = tm ? tm[1] + '年' + tm[2] + '月' + tm[3] + '日' : '';
    return [
      { key: 'idBoth', label: '身分證正反面', img: (imgs.idFront || imgs.idBack) ? 'both' : null, big: true, both: true, re: /身[分份]證.{0,8}正反面(影本)?(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?/g },
      { key: 'idFront', label: '身分證正面', img: imgs.idFront && 'lbs_img_idFront', big: true, re: /身[分份]證.{0,6}正面(影本)?(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?|正面影本(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?/g },
      { key: 'idBack',  label: '身分證反面', img: imgs.idBack && 'lbs_img_idBack',  big: true, re: /身[分份]證.{0,6}[反背]面(影本)?(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?|[反背]面影本(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?/g },
      { key: 'bank',    label: '存摺封面',   img: imgs.bank && 'lbs_img_bank',      big: true, re: /存[摺簿].{0,6}(影本|封面)(影本)?(黏貼處|粘貼處|浮貼處|貼上處|黏貼|粘貼)?/g },
      { key: 'idFront', label: '身分證正面', img: imgs.idFront && 'lbs_img_idFront', big: true, whole: true, re: /^正面$/g },
      { key: 'idBack',  label: '身分證反面', img: imgs.idBack && 'lbs_img_idBack',  big: true, whole: true, re: /^[反背]面$/g },
      { key: 'id',  label: '身分證字號', value: profile.id, boxes: true, re: /(國民)?身[分份]證(統一)?(字號|編號|號碼|證號|號)?/g },
      { key: 'residency', label: '居留證/護照', value: profile.residency, boxes: true, re: /居留證.{0,4}號碼?|護照號碼/g },
      { key: 'birth', label: '出生年月日', value: bm ? '民國' + bm[1] + '年' + bm[2] + '月' + bm[3] + '日' : '', date: bm ? [bm[1], bm[2], bm[3]] : null, re: /出生年月日|出生日期|生日|出生/g },
      { key: 'addr',  label: '戶籍地址', value: profile.addr, re: /戶籍(所在)?地址?/g },
      { key: 'addr2', label: '通訊地址', value: profile.addr2 || profile.addr, re: /(通訊|聯絡|連絡|現居|居住|郵寄)(地址|處|地)/g },
      { key: 'addr',  label: '地址', value: profile.addr, re: /住址|地址/g },
      { key: 'email', label: 'Email', value: profile.email, re: /e-?mail|電子郵件(信箱|地址)?|電子信箱|信箱/gi },
      { key: 'phone', label: '電話', value: profile.phone, re: /(聯絡|連絡|行動|手機)電話|電話號碼|手機號碼|手機|電話/g },
      { key: 'bank_holder', label: '戶名', value: profile.bank_holder, re: /戶名|帳戶名稱/g },
      { key: 'branch_code', label: '分行代碼', value: profile.branch_code, boxes: true, re: /分行(代碼|代號)/g },
      { key: 'bank_code',   label: '銀行代碼', value: profile.bank_code, boxes: true, re: /(銀行|總行|金融機構|解款行)(代碼|代號)/g },
      { key: 'bank_acc',    label: '帳號', value: profile.bank_acc, boxes: true, re: /(銀行|存款|匯款|入帳|撥款|郵局|帳戶)?(帳號|帳戶號碼)/g },
      { key: 'bank_branch', label: '分行', value: profile.bank_branch, suffix: /分行$/, re: /分行(名稱|別)?/g },
      { key: 'bank_name',   label: '銀行名稱', value: profile.bank_name, suffix: /銀行$/, re: /(受款|匯款|往來|入帳|撥款)?(銀行|金融機構)(名稱|別)?/g },
      { key: 'today', label: '填表日期', value: today, date: tm ? [tm[1], tm[2], tm[3]] : null, re: /(填表|填寫|立據|申請|簽署|簽名|簽約|立約)日期/g },
      { key: 'today', label: '填表日期', value: today, date: tm ? [tm[1], tm[2], tm[3]] : null, needColon: true, re: /日期/g },
      { key: 'sig', label: '簽名', img: sigKey, re: /簽名|簽章|蓋章|簽收|親簽/g },
      { key: 'name', label: '姓名', value: profile.name, re: /(所得人|領款人|受領人|受款人|立據人|具領人|申請人|收款人)?姓名/g },
      { key: 'name', label: '姓名', value: profile.name, needColon: true, re: /所得人|領款人|受領人|立據人|具領人|領據人|乙方|負責人/g },
      { key: 'id',  label: '身分證字號', value: profile.id, needColon: true, re: /統一編號|統一證號/g },
    ];
  }

  function fontOf(labH) { return Math.max(15, Math.min(26, labH * 0.95)); }       // 分析畫布上的字高(px)
  function fsOut(px) { return Math.round(px / S / 0.72 * 10) / 10; }               // → placement.fontSize
  function textW(str, px) { mctx.font = px + 'px ' + FONT; return mctx.measureText(str).width; }

  function charsIn(P, r, band) {
    return P.chars.filter(function (c) {
      if (c.filler) return false;
      var cx = (c.x0 + c.x1) / 2;
      return cx > r.L && cx < r.R && c.cy > r.T && c.cy < r.B;
    });
  }

  function runPage(P, pageNum, rules, out, report) {
    var usedCells = {};
    function cellKey(c) { return [Math.round(c.L / 6), Math.round(c.T / 6), Math.round(c.R / 6), Math.round(c.B / 6)].join(','); }
    function nid() { return 'pl_auto_' + pageNum + '_' + out.length + '_' + Math.random().toString(36).slice(2, 6); }
    var placedPts = [];
    function pushText(rule, x, y, px, anchor, extra) {
      // 同一個位置不重複放（例如「銀行：＿＿銀行」會被兩條規則都找到）
      for (var q = 0; q < placedPts.length; q++) if (Math.abs(placedPts[q][1] - y) < px * 0.8 && Math.abs(placedPts[q][0] - x) < px * 3) return false;
      placedPts.push([x, y]);
      var p = { id: nid(), page: pageNum, nx: x / P.w, ny: y / P.h, nw: 0.22, nh: 0.14, key: rule.key, value: rule.value, label: rule.label,
                isImage: false, storageKey: null, fontSize: fsOut(px), center: true, auto: true };
      if (anchor) p.anchor = anchor;
      if (extra) for (var k in extra) p[k] = extra[k];
      out.push(p); report.placed[rule.label] = true;
      return true;
    }
    // 太長塞不下、但格子夠高 → 拆成兩行
    function wrap2(str, px, avail) {
      var arr = Array.from(String(str)), best = null;
      for (var b = 2; b < arr.length - 1; b++) {
        var a1 = arr.slice(0, b).join(''), a2 = arr.slice(b).join('');
        var m = Math.max(textW(a1, px), textW(a2, px));
        if (!best || m < best.m) best = { m: m, s: a1 + '\n' + a2 };
      }
      return best;
    }
    function pushImg(rule, L, T, bw, bh) {
      out.push({ id: nid(), page: pageNum, nx: L / P.w, ny: T / P.h, nw: bw / P.w, nh: bh / P.h, key: rule.key, value: null, label: rule.label,
                 isImage: true, storageKey: rule.img, fontSize: 12, auto: true });
      report.placed[rule.label] = true;
    }
    function fit(str, px, avail) { var tw = textW(str, px); return tw > avail ? Math.max(px * avail / tw, px * 0.6) : px; }

    // 找「  年  月  日」挖空：回傳 [年,月,日] 三個字元
    function dateTemplateIn(r) {
      var cs = charsIn(P, r).sort(function (a, b) { return a.cy - b.cy || a.x0 - b.x0; });
      for (var i = 0; i < cs.length; i++) if (cs[i].ch === '年' && !cs[i].dateUsed) {
        var m = null, d = null;
        for (var j = i + 1; j < cs.length && j < i + 8; j++) {
          if (!m && cs[j].ch === '月') m = cs[j];
          else if (m && cs[j].ch === '日') { d = cs[j]; break; }
          else if (!/[0-9０-９]/.test(cs[j].ch)) break;       // 年月日中間只能是已經填好的數字
        }
        if (m && d && Math.abs(m.cy - cs[i].cy) < cs[i].h && Math.abs(d.cy - cs[i].cy) < cs[i].h) return [cs[i], m, d];
      }
      return null;
    }
    function fillDate(tpl, vals, rule, leftLimit) {
      var prevEnd = leftLimit;
      tpl.forEach(function (c, i) {
        // 這個字左邊最近的非空白字
        var pe = prevEnd;
        P.chars.forEach(function (o) { if (!o.filler && o !== c && Math.abs(o.cy - c.cy) < 0.6 * c.h && o.x1 <= c.x0 + 1 && o.x1 > pe) pe = o.x1; });
        c.dateUsed = true;
        // 這一格已經有數字（對方先填好了）→ 不要再疊上去
        var filled = P.chars.some(function (o) { return /[0-9０-９]/.test(o.ch) && Math.abs(o.cy - c.cy) < 0.6 * c.h && o.x1 <= c.x0 + 1 && o.x1 >= pe - 1 && c.x0 - o.x1 < 1.5 * c.h; });
        if (filled) { prevEnd = c.x1; return; }
        var gs = Math.max(pe, c.x0 - 4.5 * c.h), gap = c.x0 - gs;
        if (gap < 0.3 * c.h || inkIn(P, gs + 1, c.cy - 0.4 * c.h, c.x0 - 1, c.cy + 0.4 * c.h) > 12) { prevEnd = c.x1; return; }
        var px = fit(String(vals[i]), fontOf(c.h), Math.max(gap - 2, c.h * 0.8));
        pushText({ key: rule.key + '_' + 'ymd'[i], value: String(vals[i]), label: rule.label }, (gs + c.x0) / 2, c.cy, px, null);
        prevEnd = c.x1;
      });
    }

    // 一字一格的小方格
    function boxRun(first, cy, labH) {
      if (!(first.cl && first.cr) || first.w > 2.4 * labH || first.w < 0.5 * labH) return null;
      var cells = [first], cur = first;
      for (var n = 0; n < 30; n++) {
        if (!cur.cr) break;
        var nx = skipLineRight(P, cur.R + 1, Math.round(cy));
        if (nx >= P.w - 2) break;
        var nc = cellAt(P, Math.min(P.w - 1, nx + Math.max(2, Math.min(6, first.w / 3))), cy);
        if (!nc.cr || Math.abs(nc.w - first.w) > Math.max(4, first.w * 0.3) || charsIn(P, nc).length) break;
        cells.push(nc); cur = nc;
      }
      return cells.length >= 2 ? cells : null;
    }

    P.segs.forEach(function (seg) {
      rules.forEach(function (rule) {
        if (!rule.value && !rule.img) return;
        rule.re.lastIndex = 0;
        var m;
        while ((m = rule.re.exec(seg.sq))) {
          var i = m.index, j = i + m[0].length, k;
          if (!m[0].length) { rule.re.lastIndex++; continue; }
          var clash = false;
          for (k = i; k < j; k++) if (seg.used[k]) clash = true;
          if (clash) continue;

          var first = seg.idx[i], last = seg.idx[j - 1];
          // 前面緊貼著別的中文字（例如「公司地址」「承辦人電話」）→ 不是我們要的欄位
          if (i > 0) {
            var pv = seg.idx[i - 1];
            if (first.x0 - pv.x1 < 0.6 * first.h && CJK.test(pv.ch)) {
              var pm = seg.sq.slice(0, i).match(/(乙方|本人|個人|受款人|領款人|所得人|受領人|立據人|具領人|申請人|收款人|匯款|受款|撥款|入帳|存摺)$/);
              if (!pm) continue;
              var i0 = i - pm[0].length;
              if (i0 > 0 && seg.idx[i0].x0 - seg.idx[i0 - 1].x1 < 0.6 * first.h && CJK.test(seg.idx[i0 - 1].ch)) continue;
              var pclash = false; for (k = i0; k < i; k++) if (seg.used[k]) pclash = true;
              if (pclash) continue;
              i = i0; first = seg.idx[i];
            }
          }
          // 標籤後面的括號說明、冒號
          var e = j;
          if (e < seg.idx.length && /[（(]/.test(seg.sq[e])) {
            var close = -1;
            for (k = e + 1; k < Math.min(seg.idx.length, e + 24); k++) if (/[）)]/.test(seg.sq[k])) { close = k; break; }
            if (close > 0 && seg.idx[e].x0 - last.x1 < 1.2 * last.h) e = close + 1;
          }
          function adj(n) { return n < seg.idx.length && seg.idx[n].x0 - seg.idx[n - 1].x1 < 0.6 * last.h; }
          // 「身分證字號/統一編號：」「姓名或名稱：」→ 把斜線後面那串也算進標籤
          if (adj(e) && /[\/／或及]/.test(seg.sq[e])) {
            var e2 = e + 1;
            while (e2 < seg.idx.length && e2 < e + 16 && adj(e2) && !/[:：]/.test(seg.sq[e2])) e2++;
            e = e2;
          }
          var colon = e < seg.idx.length && /[:：]/.test(seg.sq[e]) && seg.idx[e].x0 - seg.idx[e - 1].x1 < 2.5 * last.h;
          if (colon) e++;
          if (rule.needColon && !colon && !(i === 0 && e === seg.idx.length)) continue;   // 沒冒號也行：整格只有這個標籤
          var endCh = seg.idx[e - 1];
          // 標籤後面緊貼著別的字或頓號（句子裡提到「姓名、地址」）→ 不是欄位
          if (!colon && adj(e) && (CJK.test(seg.sq[e]) || /[、,，。；;]/.test(seg.sq[e]))) continue;
          for (k = i; k < e; k++) seg.used[k] = true;

          var lab = { x0: first.x0, x1: endCh.x1, y0: Math.min(first.y0, endCh.y0), y1: Math.max(first.y1, endCh.y1), h: first.h };
          lab.cy = (first.cy + last.cy) / 2; lab.cx = (first.x0 + last.x1) / 2;
          var hh = lab.h;
          var c = cellAt(P, lab.cx, lab.cy);

          // 同一行右邊的空白範圍
          var limitR = c.cr ? c.R : P.w - 12, nextX = limitR;
          var labSet = seg.idx.slice(i, e);
          P.chars.forEach(function (o) {
            if (o.filler || o.x0 < endCh.x1 - 1 || Math.abs(o.cy - lab.cy) > 0.6 * hh || labSet.indexOf(o) >= 0) return;
            if (o.x0 < nextX) nextX = o.x0;
          });
          var spanStart = endCh.x1 + 0.35 * hh;
          var spanEnd = nextX < limitR ? nextX - 0.5 * hh : limitR - 0.25 * hh;
          var avail = spanEnd - spanStart;
          var underline = false;
          if (avail > hh) {
            var sx = Math.round(spanStart + Math.min(avail / 2, 2 * hh));
            for (var yy = Math.round(lab.y1 - 0.25 * hh); yy <= Math.round(lab.y1 + 0.7 * hh); yy++) if (hAt(P, sx, yy) && !(c.cb && yy >= c.B)) { underline = true; break; }
            if (!underline) underline = P.chars.some(function (o) { return /[_＿﹍﹎]/.test(o.ch) && o.x0 >= endCh.x1 - 1 && o.x0 < spanEnd && Math.abs(o.cy - lab.cy) < hh; });
          }

          var rc = null, bc = null;
          if (c.cr) { var rx = skipLineRight(P, c.R + 1, Math.round(lab.cy)); if (rx < P.w - 8) { rc = cellAt(P, rx + 6, lab.cy); if (rc.w < 0.5 * hh || !rc.cl || !rc.cr) rc = null; } }
          if (c.cb) { var by = skipLineDown(P, Math.round(lab.cx), c.B + 1); if (by < P.h - 8) { bc = cellAt(P, lab.cx, by + 6); if (bc.h < 0.9 * hh || !bc.cb || !bc.cl || !bc.cr) bc = null; } }
          var rcEmpty = rc && !charsIn(P, rc).length && !usedCells[cellKey(rc)] && !cellInk(P, rc);
          var bcEmpty = bc && !charsIn(P, bc).length && !usedCells[cellKey(bc)] && !cellInk(P, bc);
          // 標籤右邊那段空白裡如果已經有筆跡／簽名圖 → 當作填過了
          var spanInk = avail > hh && inkIn(P, spanStart, lab.cy - 0.45 * hh, Math.min(spanEnd, spanStart + 14 * hh), lab.cy + 0.45 * hh) > INK_MAX;

          if (report.debug) report.debug.push({ pg: pageNum, rule: rule.label, m: seg.sq.slice(i, e), seg: seg.sq.slice(0, 40), colon: colon, ul: underline, avail: Math.round(avail), hh: Math.round(hh),
            c: [c.L, c.T, c.R, c.B, +c.cl, +c.cr, +c.ct, +c.cb].join(','), rc: rc ? [rc.L, rc.T, rc.R, rc.B].join(',') + (rcEmpty ? ' empty' : ' occ') : null, bc: bc ? [bc.L, bc.T, bc.R, bc.B].join(',') + (bcEmpty ? ' empty' : ' occ') : null,
            lab: [Math.round(lab.x0), Math.round(lab.y0), Math.round(lab.x1), Math.round(lab.y1)].join(','), nextX: Math.round(nextX), limitR: limitR });
          /* ── 圖片 ── */
          if (rule.img) {
            if (spanInk && !rule.big) { report.skipped[rule.label] = true; continue; }
            if (rule.both) {
              // 「身分證正反面影本」下面（或右邊）兩個並排的大格子：左放正面、右放反面
              var b1 = (bcEmpty && bc.w >= 200 && bc.h >= 120) ? bc : ((rcEmpty && rc.w >= 200 && rc.h >= 120) ? rc : null), b2 = null;
              if (b1 && b1.cr) {
                var x2 = skipLineRight(P, b1.R + 1, Math.round((b1.T + b1.B) / 2));
                if (x2 < P.w - 8) { b2 = cellAt(P, x2 + 6, (b1.T + b1.B) / 2); if (!(b2.cl && b2.cr && b2.w >= 200 && b2.h >= 120) || charsIn(P, b2).length || cellInk(P, b2)) b2 = null; }
              }
              if (b1 && report.imgs.idFront) { pushImg({ key: 'idFront', label: '身分證正面', img: 'lbs_img_idFront' }, b1.L + 6, b1.T + 6, b1.w - 12, b1.h - 12); usedCells[cellKey(b1)] = 1; }
              if (b2 && report.imgs.idBack) { pushImg({ key: 'idBack', label: '身分證反面', img: 'lbs_img_idBack' }, b2.L + 6, b2.T + 6, b2.w - 12, b2.h - 12); usedCells[cellKey(b2)] = 1; }
              continue;
            }
            if (rule.big) {
              var pad = 6, tgt = null;
              if (c.cl && c.cr && c.ct && c.cb && c.w >= 200 && c.h >= 120) tgt = c;
              else if (rcEmpty && rc.w >= 200 && rc.h >= 120) tgt = rc;
              else if (bcEmpty && bc.w >= 200 && bc.h >= 120) tgt = bc;
              if (tgt) { pushImg(rule, tgt.L + pad, tgt.T + pad, tgt.w - 2 * pad, tgt.h - 2 * pad); usedCells[cellKey(tgt)] = 1; }
              continue;
            }
            var bw, bh;
            if ((colon || underline) && avail >= 3 * hh && !(rc && c.cl && c.cr && !underline && (avail < 6 * hh || (lab.x1 - c.L) > 0.45 * c.w))) {
              bh = 2.4 * hh; bw = Math.min(avail, 7 * hh);
              var top = lab.cy - bh / 2;
              if (c.ct) top = Math.max(top, c.T + 2); if (c.cb) top = Math.min(top, c.B - 2 - bh);
              pushImg(rule, spanStart, top, bw, bh);
            } else if (rcEmpty && rc.h >= 1.2 * hh) {
              bw = Math.min(rc.w - 8, 9 * hh); bh = Math.min(rc.h - 6, 3.2 * hh);
              pushImg(rule, rc.L + 4, (rc.T + rc.B) / 2 - bh / 2, bw, bh); usedCells[cellKey(rc)] = 1;
            } else if (bcEmpty && bc.h >= 1.2 * hh) {
              bw = Math.min(bc.w - 8, 9 * hh); bh = Math.min(bc.h - 6, 3.2 * hh);
              pushImg(rule, (bc.L + bc.R) / 2 - bw / 2, (bc.T + bc.B) / 2 - bh / 2, bw, bh); usedCells[cellKey(bc)] = 1;
            }
            continue;
          }

          /* ── 生日：先找「  年  月  日」挖空 ── */
          if (rule.date) {
            var tpl = null, lim = endCh.x1;
            var same = { L: endCh.x1, R: limitR, T: lab.cy - 0.7 * hh, B: lab.cy + 0.7 * hh };
            tpl = dateTemplateIn(same);
            if (!tpl && rc) { tpl = dateTemplateIn(rc); lim = rc.L; }
            if (!tpl && bc) { tpl = dateTemplateIn(bc); lim = bc.L; }
            if (tpl) {
              var ctxStr = P.chars.filter(function (o) { return !o.filler && Math.abs(o.cy - tpl[0].cy) < 0.6 * hh && o.x1 <= tpl[0].x0 && o.x0 >= lim - 1; }).map(function (o) { return o.ch; }).join('');
              var yv = rule.date[0]; if (/西元|公元/.test(ctxStr)) yv = String(+yv + 1911);
              fillDate(tpl, [yv, rule.date[1], rule.date[2]], rule, lim);
              continue;
            }
            // 後面已經有寫到一半的日期（有「年」或「月」）→ 不要再整串蓋上去
            if (charsIn(P, same).some(function (o) { return o.ch === '年' || o.ch === '月'; })) { report.skipped[rule.label] = true; continue; }
          }

          var px = fontOf(hh);
          /* ── 「＿＿＿銀行 ＿＿＿分行」：空格在標籤左邊 ── */
          if (rule.suffix && !colon) {
            var pe = c.cl ? c.L : 0;
            P.chars.forEach(function (o) { if (!o.filler && Math.abs(o.cy - lab.cy) < 0.6 * hh && o.x1 <= first.x0 + 1 && o.x1 > pe) pe = o.x1; });
            var gapL = first.x0 - pe, ulL = false;
            if (gapL >= 2 * hh) {
              var mx = Math.round((pe + first.x0) / 2);
              for (var y2 = Math.round(lab.y1 - 0.25 * hh); y2 <= Math.round(lab.y1 + 0.7 * hh); y2++) if (hAt(P, mx, y2) && !(c.cb && y2 >= c.B)) { ulL = true; break; }
              if (ulL && inkIn(P, pe + 2, lab.cy - 0.45 * hh, first.x0 - 2, lab.cy + 0.45 * hh) > INK_MAX) ulL = false;
              else if (!ulL) ulL = P.chars.some(function (o) { return /[_＿﹍﹎]/.test(o.ch) && o.x0 >= pe - 1 && o.x1 <= first.x0 + 1 && Math.abs(o.cy - lab.cy) < hh; });
            }
            if (ulL) {
              var sv = String(rule.value).replace(rule.suffix, '') || rule.value;
              var gs2 = Math.max(pe + 0.2 * hh, first.x0 - 9 * hh);
              pushText({ key: rule.key, value: sv, label: rule.label }, (gs2 + first.x0) / 2, lab.cy, fit(sv, px, first.x0 - gs2 - 0.3 * hh), null);
              continue;
            }
          }
          /* ── A. 同一格、標籤右邊 ── */
          // 表格型：標籤自己佔一格、答案在右邊那格 → 不要塞在標籤格裡（右格有字＝已經填過）
          var tableStyle = !!rc && c.cl && c.cr && !underline && (avail < 6 * hh || textW(rule.value, px) > avail || (lab.x1 - c.L) > 0.45 * c.w);
          if (tableStyle && !rcEmpty) { report.skipped[rule.label] = true; continue; }
          if (!tableStyle && (colon || underline) && avail >= 2.5 * hh) {
            if (spanInk) { report.skipped[rule.label] = true; continue; }
            var va = rule.value;
            if (rule.suffix && nextX < limitR) {   // 「銀行：＿＿＿銀行」→ 空格裡不用再寫一次「銀行」
              var nxt = P.chars.filter(function (o) { return !o.filler && Math.abs(o.cy - lab.cy) < 0.6 * hh && o.x0 >= nextX - 1; }).sort(function (a, b) { return a.x0 - b.x0; }).slice(0, 2).map(function (o) { return o.ch; }).join('');
              if (rule.suffix.test(nxt)) va = String(va).replace(rule.suffix, '') || va;
            }
            var roomBelow = (c.cb ? c.B : P.h) - lab.cy;
            // 空格比要填的字短太多（例如地址被拆成「＿市＿區＿路」一小格一小格）→ 不硬塞，留給手動
            if (textW(va, px) * 0.6 > avail * 2.05) { report.skipped[rule.label] = true; continue; }
            var belowFree = !charsIn(P, { L: spanStart, R: spanEnd, T: lab.cy + 0.6 * px, B: lab.cy + 2.0 * px }).length;
            if (/^addr/.test(rule.key) && Array.from(String(va)).length >= 8 && textW(va, px) > avail * 1.15 && roomBelow >= 2.1 * px && belowFree) {
              var w2 = wrap2(va, px, avail);
              var f2 = w2.m > avail ? Math.max(px * avail / w2.m, px * 0.6) : px;
              pushText({ key: rule.key, value: w2.s, label: rule.label }, spanStart, lab.cy + f2 * 0.625, f2, 'left');
            } else {
              pushText({ key: rule.key, value: va, label: rule.label }, spanStart, lab.cy, fit(va, px, avail), 'left');
            }
            continue;
          }
          /* ── B. 右邊那一格（含一字一格） ── */
          if (rcEmpty) {
            var run = rule.boxes ? boxRun(rc, lab.cy, hh) : null;
            var val = String(rule.value).replace(/\s/g, '');
            if (run && run.length >= val.length) {
              var c0 = (run[0].L + run[0].R) / 2, cN = (run[run.length - 1].L + run[run.length - 1].R) / 2;
              var pitch = (cN - c0) / (run.length - 1);
              var by2 = run[0].ct && run[0].cb ? (run[0].T + run[0].B) / 2 : lab.cy;
              pushText({ key: rule.key, value: val, label: rule.label }, c0, by2, Math.min(px, run[0].w * 0.8), null, { pitch: pitch / P.w });
              run.forEach(function (b) { usedCells[cellKey(b)] = 1; });
            } else {
              var ry = (rc.ct && rc.cb) ? (rc.T + rc.B) / 2 : lab.cy;
              var availB = rc.w - 0.8 * hh;
              if (/^addr/.test(rule.key) && Array.from(String(rule.value)).length >= 8 && textW(rule.value, px) > availB * 1.15 && rc.ct && rc.cb && rc.h >= 2.7 * px) {
                var wb = wrap2(rule.value, px, availB);
                pushText({ key: rule.key, value: wb.s, label: rule.label }, rc.L + 0.4 * hh, ry, wb.m > availB ? Math.max(px * availB / wb.m, px * 0.6) : px, 'left');
              } else {
                pushText(rule, rc.L + 0.4 * hh, ry, fit(rule.value, px, availB), 'left');
              }
              usedCells[cellKey(rc)] = 1;
            }
            continue;
          }
          /* ── C. 下面那一格 ── */
          if (bcEmpty && bc.cl && bc.cr) {
            var fc = fit(rule.value, px, bc.w - 0.6 * hh);
            pushText(rule, (bc.L + bc.R) / 2, (bc.T + bc.B) / 2, fc, null);
            usedCells[cellKey(bc)] = 1;
            continue;
          }
          /* ── A'. 沒冒號但同一格後面整片空白 ── */
          if (!spanInk && nextX >= limitR && (avail >= 8 * hh || (avail >= 4 * hh && !(c.cl && c.cr)))) {
            pushText(rule, spanStart, lab.cy, fit(rule.value, px, avail), 'left');
            continue;
          }
          report.skipped[rule.label] = true;
        }
      });
    });

    /* ── 剩下的「  年  月  日」挖空 → 填今天（排除期間、給付日等） ── */
    var tm = (report.profile.today_roc || '').match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
    if (tm) P.lines.forEach(function (L) {
      var seg = { idx: L.chars.filter(function (o) { return !o.filler; }) };
      seg.sq = seg.idx.map(function (o) { return o.ch; }).join('');
      var re = /([0-9０-９]{0,4})年([0-9０-９]{0,2})月([0-9０-９]{0,2})日/g, mm;
      while ((mm = re.exec(seg.sq))) {
        var at = mm.index + mm[1].length, atM = at + 1 + mm[2].length, atD = atM + 1 + mm[3].length;
        var cy = seg.idx[at];
        if (cy.dateUsed) continue;
        if (mm[1] && mm[2] && mm[3]) continue;                       // 整個日期都填好了
        if (seg.idx[atD].x0 - cy.x0 > 22 * cy.h) continue;           // 年月日離太遠，不像同一個日期
        var before = seg.sq.slice(Math.max(0, mm.index - 10), mm.index), after = seg.sq.slice(atD + 1, atD + 7);
        // 同一行更左邊（被格線切開的）文字也算上下文
        var leftTxt = P.chars.filter(function (o) { return !o.filler && Math.abs(o.cy - cy.cy) < 0.6 * cy.h && o.x1 <= cy.x0; }).map(function (o) { return o.ch; }).join('').slice(-14);
        var ctx = leftTxt + '|' + before + '|' + after;
        if (/出生|生日|[自至起迄止]|期間|期限|給付|支付|匯款|付款|活動|服務|勞務|演出|授課|上課|講授|執行|工作|出席|發票|到期|有效|請於|截止|以前|之前|\|前|寄回|繳回|回傳/.test(ctx)) continue;
        var lim = (mm.index > 0 ? seg.idx[mm.index - 1].x1 : cy.x0 - 4.5 * cy.h);
        var yv = /西元|公元/.test(ctx) ? String(+tm[1] + 1911) : tm[1];
        fillDate([seg.idx[at], seg.idx[atM], seg.idx[atD]], [yv, tm[2], tm[3]], { key: 'today', label: '填表日期' }, Math.max(0, lim));
      }
    });
  }

  /* ── 4. 對外 ─────────────────────────────────────────── */
  async function run(opts) {
    var pdf = opts.pdf, profile = opts.profile, layers = opts.docLayers || null;
    var imgs = {
      idFront: !!localStorage.getItem('lbs_img_idFront'), idBack: !!localStorage.getItem('lbs_img_idBack'),
      bank: !!localStorage.getItem('lbs_img_bank'), sig: !!localStorage.getItem('lbs_sig'), stamp: !!localStorage.getItem('lbs_stamp'),
    };
    var out = [], report = { placed: {}, skipped: {}, noText: false, profile: profile, pages: pdf.numPages, imgs: imgs, debug: opts.debug ? [] : null };
    var totalChars = 0;
    for (var n = 1; n <= pdf.numPages; n++) {
      var page = await pdf.getPage(n);
      var P = await analyzePage(page, layers && layers[n - 1]);
      totalChars += P.chars.length;
      runPage(P, n, buildRules(profile, imgs), out, report);
    }
    report.noText = totalChars < 5;
    Object.keys(report.placed).forEach(function (k) { delete report.skipped[k]; });
    return { placements: out, report: report };
  }

  /* 量 DOM 裡每個字的位置（Word / Excel 轉檔時用），回傳 0~1 比例座標 */
  function captureChars(root) {
    var pr = root.getBoundingClientRect(), out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var range = document.createRange(), n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue, pe = n.parentElement;
      if (!t || !pe) continue;
      var cs = getComputedStyle(pe);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var fs = parseFloat(cs.fontSize) || 12;
      for (var i = 0; i < t.length; i++) {
        var code = t.charCodeAt(i), len = (code >= 0xd800 && code <= 0xdbff && i + 1 < t.length) ? 2 : 1;
        var ch = t.substr(i, len);
        if (ch === '\n' || ch === '\r') continue;
        range.setStart(n, i); range.setEnd(n, i + len);
        var r = range.getBoundingClientRect();
        if (len === 2) i++;
        if (!r || r.width === 0) continue;
        out.push({ ch: ch, x0: (r.left - pr.left) / pr.width, x1: (r.right - pr.left) / pr.width,
                   cy: ((r.top + r.bottom) / 2 - pr.top) / pr.height, fs: fs / pr.height });
      }
    }
    return out;
  }

  return { run: run, captureChars: captureChars, _analyzePage: analyzePage, _cellAt: cellAt };
})();
