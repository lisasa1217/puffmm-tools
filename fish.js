/* ==========================================================
   首頁小池塘（養成小遊戲）
   - 像素風 canvas：蝌蚪 → 長腳 → 變青蛙，水草、氣泡、沙地、石頭
   - 餵食（按鈕或直接點水裡）→ 游過去吃 → 累積吃的次數長大
     Lv.1 蝌蚪（0-4 次）→ Lv.2 長腳蝌蚪（5-14 次）→ Lv.3 青蛙（15+ 次）
   - 飽足度會隨時間下降（約 16 小時掉到最低），太餓會慢慢沉到底部、動作變慢
   - 資料只存在這台裝置的 localStorage（key: puff_pet_v1），不上傳
   - 2026-10-02：原本是金魚，使用者要求換成蝌蚪養成，整個換掉（不是加第二隻）
   ========================================================== */
(function () {
  var cv = document.getElementById('fishCanvas');
  if (!cv || document.documentElement.classList.contains('go')) return;
  var ctx = cv.getContext('2d');

  var PXS = 2;            // 1 個邏輯像素 = 2 個 CSS 像素（細緻）
  var H = 54;             // 水缸邏輯高度 → 108 CSS px
  var SAND = 8;           // 沙地高度
  var W = 0;
  var KEY = 'puff_pet_v1';

  /* ── 存檔 ─────────────────────────────── */
  var S = { name: '小蝌', fed: 0, hunger: 70, t: Date.now() };
  try {
    var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') S = Object.assign(S, raw);
  } catch (e) {}
  (function decay() {                    // 離開期間的飽足度下降
    var hrs = Math.max(0, (Date.now() - (S.t || Date.now())) / 36e5);
    S.hunger = Math.max(15, S.hunger - hrs * (85 / 16));
    S.t = Date.now();
  })();
  function save() { S.t = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  function levelOf(n) { return n >= 15 ? 3 : n >= 5 ? 2 : 1; }

  /* ── 精靈圖：三個成長階段，各自 body(8寬) + tail/legs(4寬) = 12寬 x 7高 ── */
  var PAL = { k: '#d9773a', O: '#ffa85c', L: '#ffd7a3', e: '#6a5153',
              g: '#8fd39a', G: '#62b57d', R: '#cfc8e0', r: '#b3abc9', d: '#4a5a3a',
              y: '#ffd96b', w: '#ffffff', m: '#eaf7d6', p: '#ee8fb1' };
  function fishRows(body, tail) { return body.map(function (b, i) { return tail[i] + b; }); }

  // Lv.1 蝌蚪：圓滾滾身體 + 細長擺動的尾巴
  var TADPOLE_BODY = ['..dddd..', '.dmmmmd.', 'dmmmmmmd', 'dmemmemd', 'dmmmmmmd', '.dmmmmd.', '..dddd..'];
  var TADPOLE_TAIL_A = ['....', '.d..', '..d.', '...d', '..d.', '.d..', '....'];
  var TADPOLE_TAIL_B = ['....', '...d', '..d.', '.d..', '..d.', '...d', '....'];

  // Lv.2 長腳蝌蚪：身體轉綠，尾巴變短，後腳冒出來
  var FROGLET_BODY = ['..gggg..', '.gmmmmg.', 'gmmmmmmg', 'gmemmemg', 'gmmmmmmg', 'GgmmmmgG', '..gggg..'];
  var FROGLET_TAIL_A = ['....', '....', '.d..', '..d.', '.d..', '....', '....'];
  var FROGLET_TAIL_B = ['....', '....', '..d.', '.d..', '..d.', '....', '....'];

  // Lv.3 青蛙：尾巴消失，換成一對會踢水的後腳
  var FROG_BODY = ['..gggg..', '.gmmmmg.', 'gmemmemg', 'gmmmmmmg', 'gmmppmmg', '.gmmmmg.', '..gggg..'];
  var FROG_LEGS_A = ['....', '.GG.', '.gg.', '.gg.', '.gg.', '.GG.', '....'];
  var FROG_LEGS_B = ['G..G', 'G..G', '.gg.', '.gg.', '.gg.', 'G..G', 'G..G'];

  function spriteSet(level) {
    if (level >= 3) return { a: fishRows(FROG_BODY, FROG_LEGS_A), b: fishRows(FROG_BODY, FROG_LEGS_B) };
    if (level === 2) return { a: fishRows(FROGLET_BODY, FROGLET_TAIL_A), b: fishRows(FROGLET_BODY, FROGLET_TAIL_B) };
    return { a: fishRows(TADPOLE_BODY, TADPOLE_TAIL_A), b: fishRows(TADPOLE_BODY, TADPOLE_TAIL_B) };
  }

  var WEED_A = ['..g..', '.gG..', '..gG.', '..g..', '.gG..', '..gG.', '..g..', '.gG..', '..g..', '..G..'];
  var WEED_B = WEED_A.map(function (r, i) { return i % 4 < 2 ? '.' + r.slice(0, 4) : r; });
  var ROCK = ['...rrrr...', '..rRRRRr..', '.rRRRdRRr.', 'rRRRRRRRRr', 'rRRdRRRRRr', '.rrrrrrrr.'];
  var SPARK = ['..y..', '..y..', 'yywyy', '..y..', '..y..'];

  function drawRows(rows, x, y, s, flip) {
    x = Math.round(x); y = Math.round(y);
    var w = rows[0].length;
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j], i = 0;
      while (i < w) {
        var ch = row[i];
        if (ch === '.') { i++; continue; }
        var i2 = i; while (i2 < w && row[i2] === ch) i2++;
        var col = PAL[ch]; if (!col) { i = i2; continue; }
        ctx.fillStyle = col;
        var px = flip ? (w - i2) : i;
        ctx.fillRect(x + px * s, y + j * s, (i2 - i) * s, s);
        i = i2;
      }
    }
  }

  /* ── 背景（預先畫好，縮放時才重畫） ───── */
  var bg = document.createElement('canvas');
  var bgc = bg.getContext('2d');
  var WEEDS = [];
  var rng = 7; function rand() { rng = (rng * 9301 + 49297) % 233280; return rng / 233280; }

  function buildBg() {
    bg.width = W; bg.height = H;
    var water = H - SAND;
    var bands = ['#e7f7f8', '#d4f0f4', '#c2e9f1', '#b1e2ed', '#a1dae8'];
    var bh = water / bands.length;
    for (var b = 0; b < bands.length; b++) {
      bgc.fillStyle = bands[b];
      bgc.fillRect(0, Math.floor(b * bh), W, Math.ceil(bh) + 1);
      if (b > 0) {            // 色帶交界做像素抖動
        bgc.fillStyle = bands[b - 1];
        var y = Math.floor(b * bh);
        for (var x = (b % 2); x < W; x += 2) bgc.fillRect(x, y, 1, 1);
      }
    }
    // 水面波紋
    bgc.fillStyle = '#ffffff';
    for (var wx = 0; wx < W; wx += 6) bgc.fillRect(wx, 0, 3, 1);
    // 沙地
    bgc.fillStyle = '#f4e2b4'; bgc.fillRect(0, water, W, SAND);
    bgc.fillStyle = '#ead29a'; bgc.fillRect(0, water, W, 1);
    rng = 11;
    for (var i = 0; i < W * 0.6; i++) {
      var sx = Math.floor(rand() * W), sy = water + 1 + Math.floor(rand() * (SAND - 1));
      bgc.fillStyle = rand() > 0.5 ? '#e6cc92' : '#fff1cf';
      bgc.fillRect(sx, sy, 1, 1);
    }
    // 石頭
    var rx = Math.floor(W * 0.62);
    drawTo(bgc, ROCK, rx, water - 5, 1);
    drawTo(bgc, ROCK, Math.floor(W * 0.18), water - 3, 1);
    // 水草位置
    WEEDS = [{ x: 8, ph: 0 }, { x: 16, ph: 1 }, { x: Math.floor(W * 0.5), ph: 0 }, { x: W - 12, ph: 1 }, { x: W - 20, ph: 0 }];
  }
  function drawTo(c, rows, x, y, s) {
    var w = rows[0].length;
    for (var j = 0; j < rows.length; j++) for (var i = 0; i < w; i++) {
      var col = PAL[rows[j][i]]; if (!col) continue;
      c.fillStyle = col; c.fillRect(x + i * s, y + j * s, s, s);
    }
  }

  /* ── 遊戲物件 ─────────────────────────── */
  var fish = { x: 30, y: 20, tx: 60, ty: 20, dir: 1, tail: 0, tailT: 0, wanderT: 0, bob: 0 };
  var food = [], bubbles = [], sparks = [];
  var flash = 0;

  function fishSize() { var s = levelOf(S.fed) + 1; return { s: s, w: 12 * s, h: 7 * s }; }
  function waterTop() { return 3; }
  function floorY() { return H - SAND; }

  function newTarget() {
    var f = fishSize();
    fish.tx = 4 + Math.random() * Math.max(1, W - f.w - 8);
    var lo = waterTop() + 2, hi = floorY() - f.h - 2;
    fish.ty = lo + Math.random() * Math.max(1, hi - lo);
    if (S.hunger < 30) fish.ty = hi - Math.random() * 6;     // 餓了沉到底部
    fish.wanderT = 2.5 + Math.random() * 3;
  }

  function say(msg, ms) {
    var el = document.getElementById('fishMsg'); if (!el) return;
    el.textContent = msg;
    clearTimeout(say._t);
    say._t = setTimeout(defaultMsg, ms || 2600);
  }
  function defaultMsg() {
    var el = document.getElementById('fishMsg'); if (!el) return;
    el.textContent = S.hunger < 30 ? '肚子餓了…' : S.hunger > 90 ? '吃得飽飽的 ♥' : '游來游去～';
  }

  function dropFood(x) {
    if (food.length >= 8) return false;
    food.push({ x: Math.max(3, Math.min(W - 4, x)), y: 3, vy: 5 + Math.random() * 2 });
    return true;
  }
  function feed() {
    if (S.hunger >= 96) { say('吃飽啦～晚點再餵', 2200); return; }
    for (var i = 0; i < 3; i++) dropFood(W * (0.2 + Math.random() * 0.6));
    say('開飯囉！', 1800);
  }

  function eat(p) {
    var before = levelOf(S.fed);
    S.fed++; S.hunger = Math.min(100, S.hunger + 12);
    save();
    bubbles.push({ x: fish.x + fishSize().w, y: fish.y + 2, vy: 9, life: 1.4 });
    var after = levelOf(S.fed);
    if (after > before) {
      sparks.push({ t: 1.6 });
      var msg = after === 2 ? '長出後腳囉！Lv.2 🐸' : after === 3 ? '變成青蛙啦！Lv.3 🐸' : '長大啦！Lv.' + after + ' ✨';
      say(msg, 3200);
    } else say(S.name + ' 吃得好開心 ♥', 1600);
    updateUI();
  }

  /* ── 更新 / 繪製 ──────────────────────── */
  function update(dt) {
    var f = fishSize();
    var chase = null, best = 1e9;
    if (S.hunger < 98) food.forEach(function (p) {
      var d = Math.abs(p.x - (fish.x + f.w / 2)) + Math.abs(p.y - (fish.y + f.h / 2));
      if (d < best) { best = d; chase = p; }
    });
    if (chase) { fish.tx = chase.x - f.w / 2; fish.ty = chase.y - f.h / 2; }
    else { fish.wanderT -= dt; if (fish.wanderT <= 0) newTarget(); }

    var speed = (chase ? 26 : 9) * (S.hunger < 30 ? 0.6 : 1);
    var dx = fish.tx - fish.x, dy = fish.ty - fish.y, dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      var step = Math.min(dist, speed * dt);
      fish.x += dx / dist * step; fish.y += dy / dist * step * 0.8;
      if (Math.abs(dx) > 1.5) fish.dir = dx > 0 ? 1 : -1;
    } else if (!chase) fish.wanderT = Math.min(fish.wanderT, 0.4);
    fish.x = Math.max(0, Math.min(W - f.w, fish.x));
    fish.y = Math.max(waterTop(), Math.min(floorY() - f.h - 1, fish.y));

    fish.tailT += dt;
    if (fish.tailT > (chase ? 0.12 : 0.28)) { fish.tailT = 0; fish.tail ^= 1; }
    fish.bob += dt;

    // 飼料
    for (var i = food.length - 1; i >= 0; i--) {
      var p = food[i];
      p.y += p.vy * dt;
      var cx = fish.x + f.w / 2, cy = fish.y + f.h / 2;
      if (S.hunger < 98 && Math.abs(p.x - cx) < f.w / 2 + 1 && Math.abs(p.y - cy) < f.h / 2 + 2) { food.splice(i, 1); eat(p); continue; }
      if (p.y >= floorY() - 1) food.splice(i, 1);
    }
    // 氣泡
    if (Math.random() < dt * 0.9) {
      var w = WEEDS[Math.floor(Math.random() * WEEDS.length)];
      if (w) bubbles.push({ x: w.x + 2, y: floorY() - 8, vy: 7 + Math.random() * 5, life: 99 });
    }
    for (var b = bubbles.length - 1; b >= 0; b--) {
      var bb = bubbles[b]; bb.y -= bb.vy * dt; bb.x += Math.sin(bb.y / 4) * 0.15; bb.life -= dt;
      if (bb.y < 1 || bb.life <= 0) bubbles.splice(b, 1);
    }
    for (var s = sparks.length - 1; s >= 0; s--) { sparks[s].t -= dt; if (sparks[s].t <= 0) sparks.splice(s, 1); }
  }

  var sway = 0, swayT = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, 0, 0);
    // 水草
    WEEDS.forEach(function (w) {
      var rows = ((sway + w.ph) % 2) ? WEED_B : WEED_A;
      drawRows(rows, w.x, floorY() - rows.length + 1, 1, false);
    });
    // 飼料
    food.forEach(function (p) {
      ctx.fillStyle = '#c98a4b'; ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
      ctx.fillStyle = '#efbf86'; ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    });
    // 金魚
    var f = fishSize();
    ctx.globalAlpha = S.hunger < 30 ? 0.75 : 1;
    var by = fish.y + Math.sin(fish.bob * 3) * 0.8;
    var sp = spriteSet(levelOf(S.fed));
    drawRows(fish.tail ? sp.b : sp.a, fish.x, by, f.s, fish.dir < 0);
    ctx.globalAlpha = 1;
    // 升級火花
    sparks.forEach(function (sp, i) {
      var k = Math.floor(sp.t * 6) % 2;
      drawRows(SPARK, fish.x - 2 + (k ? 0 : f.w - 2), by - 6 + k * 2, 1, false);
      drawRows(SPARK, fish.x + f.w / 2 - 2, by - 8 - k, 1, false);
    });
    // 氣泡
    bubbles.forEach(function (b) {
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(Math.round(b.x), Math.round(b.y), 2, 2);
      ctx.fillStyle = 'rgba(170,215,235,.9)'; ctx.fillRect(Math.round(b.x) + 1, Math.round(b.y) + 1, 1, 1);
    });
  }

  /* ── 介面 ─────────────────────────────── */
  var meter = document.getElementById('fishMeter');
  var SEG = 10;
  if (meter) for (var i = 0; i < SEG; i++) meter.appendChild(document.createElement('i'));
  function updateUI() {
    var nameEl = document.getElementById('fishName'), lvEl = document.getElementById('fishLv');
    if (nameEl) nameEl.textContent = S.name;
    if (lvEl) lvEl.textContent = 'Lv.' + levelOf(S.fed);
    if (meter) {
      var on = Math.round(S.hunger / 100 * SEG);
      Array.prototype.forEach.call(meter.children, function (el, i) { el.className = i < on ? 'on' + (on <= 3 ? ' low' : '') : ''; });
    }
  }

  var feedBtn = document.getElementById('fishFeed');
  if (feedBtn) feedBtn.addEventListener('click', feed);
  var nameBtn = document.getElementById('fishName');
  if (nameBtn) nameBtn.addEventListener('click', function () {
    var n = prompt('幫金魚取個名字（最多 6 個字）', S.name);
    if (n && n.trim()) { S.name = n.trim().slice(0, 6); save(); updateUI(); say('我叫 ' + S.name + '！', 2000); }
  });
  cv.addEventListener('click', function (e) {
    var r = cv.getBoundingClientRect();
    if (S.hunger >= 96) { say('吃飽啦～晚點再餵', 2000); return; }
    dropFood((e.clientX - r.left) / r.width * W);
  });

  /* ── 尺寸 / 主迴圈 ────────────────────── */
  function resize() {
    var cw = cv.parentNode.clientWidth || 300;
    var nw = Math.max(80, Math.floor(cw / PXS));
    if (nw === W) return;
    W = nw; cv.width = W; cv.height = H;
    cv.style.height = (H * PXS) + 'px';
    buildBg();
    fish.x = Math.min(fish.x, Math.max(0, W - fishSize().w));
    newTarget();
  }
  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv.parentNode);
  else window.addEventListener('resize', resize);

  updateUI(); defaultMsg(); newTarget();
  fish.x = Math.random() * (W * 0.5); fish.y = 14;
  draw();   // 先畫第一幀，避免等 rAF 之前（或分頁在背景時）水缸是空白

  var last = performance.now(), acc = 0, hungerT = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) { last = now; return; }
    var dt = Math.min(0.2, (now - last) / 1000); last = now; acc += dt;
    if (acc < 1 / 15) return;                 // 復古 15fps
    swayT += acc; if (swayT > 0.7) { swayT = 0; sway ^= 1; }
    update(acc); draw();
    hungerT += acc;
    if (hungerT > 20) {                       // 每 20 秒扣一點、存檔
      hungerT = 0; S.hunger = Math.max(15, S.hunger - 85 / 16 / 180); save(); updateUI();
      if (S.hunger < 30) defaultMsg();
    }
    acc = 0;
  }
  requestAnimationFrame(loop);
  window.addEventListener('pagehide', save);
})();
