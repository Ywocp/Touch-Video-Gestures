// 手势引擎：document 级捕获监听 + 触点几何路由
// 设计要点：
//   1. 不在播放器容器上绑事件，而是 document 捕获阶段统一接收——
//      部分站点（如 Pornhub）的播放器脚本会在自身节点层拦截/停止传播触摸事件，
//      容器级监听可能根本收不到；document 捕获最先收到，无法被中间层绕过。
//   2. 触摸起手时按"触点落在哪个视频的矩形内"路由到该视频（取最小命中矩形），
//      天然支持同页多视频：点到哪个就操作哪个。
window.TVG = window.TVG || {};
TVG.Gestures = (function () {
  'use strict';

  var clamp = TVG.clamp;

  function fmt(sec) {
    if (!isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }
  TVG.fmt = fmt;

  var registry = [];          // 已注册视频：{ v: video, c: container }
  var lastReject = '';        // 最近一次注册失败原因（诊断用）
  var attempts = 0;           // 注册尝试次数（诊断用）
  var brightnessMap = new WeakMap();
  var lastTapMap = new WeakMap();
  var seq = null;             // 当前手势序列
  var fsGrab = null;          // 非全屏时临时锁定 pan-y 的容器（中间带起手）
  var inited = false;

  function cfg() { return TVG.Settings || TVG.DEFAULTS; }

  // 关键修复：不能只看类名就放行——Plyr/Pornhub 等播放器的"中央大播放按钮"
  // 覆盖层类名恰好含 control/btn，若按类名一刀切，点击视频中央的手势全被放行。
  // 真正的控件（进度条/音量条/按钮）面积都很小；大面积覆盖层不算控件。
  function isUiTarget(t) {
    if (!t || !t.closest) return false;
    var ui = t.closest(
      'button,a,input,select,textarea,label,[role="button"],' +
      '[class*="control" i],[class*="slider" i],[class*="btn" i],' +
      '[class*="volume" i],[class*="menu" i],[class*="setting" i],[class*="progress" i]');
    if (!ui) return false;
    var r = ui.getBoundingClientRect();
    var vw = innerWidth || 1, vh = innerHeight || 1;
    // 面积超过视口 12%，或 宽>70%视口 且 高>25%视口 → 是大面积覆盖层，不是控件
    if (r.width * r.height > 0.12 * vw * vh) return false;
    if (r.width > 0.7 * vw && r.height > 0.25 * vh) return false;
    return true;
  }

  // 触点命中的视频（多个重叠时取矩形最小的）。
  // 视频不可见（0 尺寸，如 canvas 渲染播放器）时用其容器矩形兜底命中。
  function hitVideo(x, y) {
    var best = null, bestArea = Infinity;
    for (var i = 0; i < registry.length; i++) {
      var e = registry[i];
      var v = e.v;
      if (!v.isConnected) continue;
      var r = v.getBoundingClientRect();
      if (r.width * r.height <= 0) {
        if (!e.c || !e.c.isConnected) continue;
        r = e.c.getBoundingClientRect();
      }
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        var a = r.width * r.height;
        if (a > 0 && a < bestArea) { best = v; bestArea = a; }
      }
    }
    return best;
  }

  function getBrightness(v) {
    var b = brightnessMap.get(v);
    return (b == null) ? 1 : b;
  }

  function setRate(v, r) {
    try { v.playbackRate = r; } catch (e) {}
  }

  function isFullscreen() {
    var fe = document.fullscreenElement;
    if (fe) {
      if (seq && (fe === seq.video || fe.contains(seq.video) ||
          (seq.cont && (fe === seq.cont || fe.contains(seq.cont))))) return true;
    }
    // 回退判定：视口尺寸≈屏幕尺寸（覆盖 iframe 内全屏、浏览器全屏、
    // 以及站点自定义"伪全屏"实现）
    return viewportIsScreen();
  }

  function viewportIsScreen() {
    try {
      var sw = screen.width, sh = screen.height;
      var m1 = Math.abs(window.innerWidth - sw) <= 2 && Math.abs(window.innerHeight - sh) <= 2;
      var m2 = Math.abs(window.innerWidth - sh) <= 2 && Math.abs(window.innerHeight - sw) <= 2;
      return m1 || m2;
    } catch (e) {
      return false;
    }
  }

  // 全屏状态下移除容器的 touch-action:pan-y（纵向滚动无意义，且会抢走
  // 音量/亮度手势的前几帧）——用 .tvg-fs 类切换，退出全屏自动恢复
  function updateFsClass() {
    var fs = !!document.fullscreenElement || viewportIsScreen();
    for (var i = 0; i < registry.length; i++) {
      var c = registry[i].c;
      if (!c || !c.classList) continue;
      if (fs) c.classList.add('tvg-fs');
      else c.classList.remove('tvg-fs');
    }
  }

  // 全屏状态（供手势 regionOf 使用；iframe 内全屏 standard API 为 null，用视口回退）
  function fsNow() {
    return !!document.fullscreenElement || viewportIsScreen();
  }

  // 纵向滑动的区域判定（参照 PiliPlus 三区，但改为按百分比可调）：
  //   中间 fsEdgePercent% 宽的窄带 → 全屏切换
  //   左侧剩余宽度的一半          → 亮度
  //   右侧剩余宽度的一半          → 音量
  // 返回 'fs' | 'bright' | 'vol' | null（功能关闭时返回 null）
  function regionOf(s, x) {
    var c = cfg();
    var w = s.rect.width || 1;
    var rel = (x - s.rect.left) / w;      // 0~1
    var half = clamp((c.fsEdgePercent || 0), 0, 80) / 200; // 窄带半宽（0~0.4）
    if (c.fsGesture && rel >= 0.5 - half && rel <= 0.5 + half) return 'fs';
    if (c.brightness && rel < 0.5) return 'bright';
    if (c.volume && rel > 0.5) return 'vol';
    // 落在外侧但对应功能关闭时，退让给另一个（避免死区）
    if (c.volume && rel < 0.5) return 'vol';
    if (c.brightness && rel > 0.5) return 'bright';
    return null;
  }

  // 进入 / 退出全屏。容器或视频均可作为全屏目标；站点自定义伪全屏无法程序化
  // 控制时，用 requestFullscreen 兜底（失败静默）。
  function toggleFullscreen(s, enter) {
    var el = (s.cont && s.cont.requestFullscreen && s.cont) ||
             (s.video && s.video.requestFullscreen && s.video) || null;
    try {
      if (enter) {
        if (!el) return false;
        var p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () {});
      } else {
        if (document.exitFullscreen) {
          var q = document.exitFullscreen();
          if (q && q.catch) q.catch(function () {});
        } else return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 序列 =====

  function startSequence(e, v) {
    var c = cfg();
    var cont = TVG.Locator.containerFor(v) || v.parentElement || v;
    seq = {
      video: v,
      cont: cont,
      rect: cont.getBoundingClientRect(),
      pointers: new Map(),
      mode: null,        // seek | scroll | speed | volume | brightness | longpress | none
      engaged: false,
      done: false,
      instant4x: false,
      moved: false,      // 本次触摸是否已产生位移（位移即取消长按判定）
      fsDone: false,     // 全屏切换是否已触发（锁定，防抖动反复切换）
      sx: e.clientX,
      sy: e.clientY,
      baseTime: v.currentTime,
      userRate: v.playbackRate,
      baseVol: v.muted ? 1 : v.volume,
      baseBright: getBrightness(v),
      lpTimer: null,
      _seekTimer: null,
      _pendingSeek: null
    };

    // 双击左/右侧快进快退
    var lt = lastTapMap.get(v);
    var now = Date.now();
    if (c.doubleTapSeek && lt && now - lt.t < c.doubleTapMs &&
        Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 60) {
      lastTapMap.delete(v);
      var rel = (e.clientX - seq.rect.left) / (seq.rect.width || 1);
      if (rel < 0.4) nudgeSeek(v, -c.seekStep, seq.rect, seq.cont);
      else if (rel > 0.6) nudgeSeek(v, c.seekStep, seq.rect, seq.cont);
      seq.done = true; // 本次触摸视为已消费
      return;
    }    lastTapMap.set(v, { t: now, x: e.clientX, y: e.clientY });

    if (c.longPress4x) {
      seq.lpTimer = setTimeout(function () {
        if (!seq || seq.pointers.size !== 1) return;
        var q = null;
        seq.pointers.forEach(function (z) { if (!q) q = z; });
        // 长按判定：必须确实没动过。双重保险 ——
        //   ① seq.moved 标志（pointermove 或 touchmove 任一到达都会置位）
        //   ② 直接用最后记录的触点位置复核位移
        // 只靠 ① 的风险：个别环境（模拟器/触控笔/合成事件）下 pointermove 可能
        // 送不到，moved 永远为 false，长按就会在用户拖动过程中误触发，
        // 表现为"拖动进度时同时冒出倍速"。
        if (!q || seq.moved) return;
        if (Math.hypot(q.x - seq.sx, q.y - seq.sy) > 8) return;
        var rate = c.longPressRate || 4;
        seq.mode = 'longpress';
        seq.engaged = true;
        setRate(seq.video, rate);
        TVG.Toast.show(rate + 'x 倍速（松开恢复）', true, 0, seq.rect, seq.cont);
      }, c.longPressMs);
    }
  }

  function onPointerDown(e) {
    var c = cfg();
    if (e.pointerType === 'mouse' && !c.mouseSupport) { releaseGrab(); return; }
    if (isUiTarget(e.target)) { releaseGrab(); return; }

    if (seq && seq.pointers.size > 0) {
      // 已有进行中的序列：第二指必须落在同一视频上
      var hit = hitVideo(e.clientX, e.clientY);
      if (!hit || hit !== seq.video) return;
      clearTimeout(seq.lpTimer);
      if (seq.mode === 'longpress') {
        setRate(seq.video, seq.userRate);
        seq.mode = null;
        seq.engaged = false;
      }
      seq.mode = null;
      seq.done = false;
      seq.baseRate = seq.userRate;
      if (c.instant4x) {
        seq.instant4x = true;
        setRate(seq.video, 4);
        TVG.Toast.show('4x 倍速', true, 0, seq && seq.rect, seq && seq.cont);
      }
      seq.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var ps = [];
      seq.pointers.forEach(function (p) { ps.push(p); });
      seq.mx = (ps[0].x + ps[1].x) / 2;
      seq.my = (ps[0].y + ps[1].y) / 2;
      return;
    }

    var v = hitVideo(e.clientX, e.clientY);
    if (!v) { releaseGrab(); return; }
    startSequence(e, v);
    seq.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function onPointerMove(e) {
    if (!seq) return;
    var p = seq.pointers.get(e.pointerId);
    if (!p || seq.done) return;
    p.x = e.clientX;
    p.y = e.clientY;
    var c = cfg();

    if (seq.pointers.size === 1) {
      var dx = e.clientX - seq.sx;
      var dy = e.clientY - seq.sy;
      // 产生位移 → 取消长按判定（在拖动进度/滑动时绝不触发长按倍速）
      if (!seq.moved && Math.hypot(dx, dy) > 8) {
        seq.moved = true;
        clearTimeout(seq.lpTimer);
      }
      // 长按倍速已生效后若手指开始拖动：立刻退出倍速，并把基准重置到当前位置，
      // 交还给下面的手势判定。否则长按一旦先触发，seq.mode 已非空，
      // 模式判定会被整个跳过 → 拖动被吞掉，只留下 2x 在跑
      // （表现为"拖动进度时同步触发了倍速"）。
      if (seq.mode === 'longpress') {
        if (Math.hypot(dx, dy) < c.moveThreshold) return;   // 尚未真正拖动，保持倍速
        setRate(seq.video, seq.userRate);
        TVG.Toast.hide();                                   // 撤掉常驻的"Nx 倍速"提示，否则会一直挂在画面上
        seq.mode = null;
        seq.engaged = false;
        seq.sx = e.clientX;
        seq.sy = e.clientY;
        seq.baseTime = seq.video.currentTime;               // 长按期间视频在播，进度基准要重取
        seq.baseVol = seq.video.muted ? 1 : seq.video.volume;
        seq.baseBright = getBrightness(seq.video);
        seq.moved = true;
        return;                                             // 本帧只复位基准，下一帧按新基准判定
      }
      if (!seq.mode) {
        if (Math.hypot(dx, dy) < c.moveThreshold) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.2 && c.progress) {
          seq.mode = 'seek';
          seq.engaged = true;
        } else {
          // 纵向手势：先看落点区域
          //   'fs'  → 全屏切换（全屏/非全屏都生效，这是退出全屏的唯一入口）
          //   'bright'/'vol' → 仅在已全屏时生效（非全屏放行给页面滚动，防误触）
          var reg = regionOf(seq, seq.sx);
          var fs = fsNow();
          if (reg === 'fs' && c.fsGesture) {
            seq.mode = 'fs';
            seq.engaged = true;
            seq.fsDone = false;
          } else if (fs && reg === 'bright') {
            seq.mode = 'brightness';
            seq.engaged = true;
            seq.baseBright = getBrightness(seq.video);
          } else if (fs && reg === 'vol') {
            seq.mode = 'volume';
            seq.engaged = true;
            seq.baseVol = seq.video.muted ? 1 : seq.video.volume;
          } else {
            // 非全屏外侧 / 功能关闭：放行给页面滚动
            seq.mode = 'scroll';
            seq.done = true;
            return;
          }
        }
      }
      if (seq.mode === 'seek') seekTo(seq, dx);
      else if (seq.mode === 'volume') setVolumeRel(seq, dy);
      else if (seq.mode === 'brightness') setBrightnessRel(seq, dy);
      else if (seq.mode === 'fs') fsSwipe(seq, dy);
    } else if (seq.pointers.size === 2) {
      var ps = [];
      seq.pointers.forEach(function (q) { ps.push(q); });
      var mx = (ps[0].x + ps[1].x) / 2;
      var my = (ps[0].y + ps[1].y) / 2;
      var ddx = mx - seq.mx;
      var ddy = my - seq.my;
      if (!seq.mode) {
        if (Math.hypot(ddx, ddy) < Math.min(10, c.moveThreshold)) return;
        seq.engaged = true;
        if (Math.abs(ddx) > Math.abs(ddy)) {
          seq.mode = c.speed ? 'speed' : 'none';
        } else if (fsNow()) {
          var regFs2 = regionOf(seq, seq.mx);
          // 双指不做全屏切换（避免与音量/亮度误触），落在全屏带时按左右就近归一
          seq.mode = (regFs2 === 'bright') ? 'brightness'
                   : (regFs2 === 'vol') ? 'volume'
                   : ((seq.mx - seq.rect.left) < seq.rect.width / 2 ? 'brightness' : 'volume');
          if (seq.mode === 'brightness' && !c.brightness) seq.mode = c.volume ? 'volume' : 'none';
          if (seq.mode === 'volume' && !c.volume) seq.mode = c.brightness ? 'brightness' : 'none';
        } else {
          // 音量/亮度仅全屏生效（防误触）
          seq.mode = 'none';
        }
        if (seq.mode === 'none') { seq.done = true; return; }
      }
      if (seq.mode === 'speed') setSpeedRel(seq, ddx);
      else if (seq.mode === 'volume') setVolumeRel(seq, ddy);
      else if (seq.mode === 'brightness') setBrightnessRel(seq, ddy);
    }
  }

  function onPointerUp(e) {
    if (!seq) return;
    if (!seq.pointers.has(e.pointerId)) return;
    seq.pointers.delete(e.pointerId);
    clearTimeout(seq.lpTimer);
    if (seq.pointers.size === 0) {
      clearTimeout(seq._seekTimer);
      var landed = (seq.mode === 'seek') ? commitSeek(seq) : null;
      if (seq.instant4x && seq.mode !== 'speed') setRate(seq.video, seq.userRate);
      if (seq.mode === 'longpress') setRate(seq.video, seq.userRate);
      if (landed != null && !cfg().seekRealtime) {
        // 非实时模式：给一次落地确认（真正的反馈是画面跳转，这里补一句文字）
        TVG.Toast.show('已跳转 ' + fmt(landed), false, 700, seq.rect, seq.cont);
      } else {
        TVG.Toast.hide();
      }
      releaseGrab();
      seq = null;
    } else if (seq.pointers.size === 1) {
      // 三指→两指 / 两指→单指：重置基准点防跳变
      var rest = null;
      seq.pointers.forEach(function (q) { if (!rest) rest = q; });
      seq.sx = rest.x;
      seq.sy = rest.y;
      seq.userRate = seq.video.playbackRate;
      seq.mode = null;
      seq.done = false;
    }
  }

  function onTouchStart(e) {
    // 序列进行中，第二指落在同一视频上：吃掉默认行为（防页面滚动/缩放）
    if (seq && seq.pointers.size >= 1 && e.touches.length >= 2 && e.cancelable && !isUiTarget(e.target)) {
      var hit = hitVideo(e.touches[0].clientX, e.touches[0].clientY);
      if (hit === seq.video) e.preventDefault();
      return;
    }
    // 非全屏时，触点落在中间全屏带：临时锁住容器的 pan-y，
    // 保证纵向滑动的前几帧不被浏览器当作页面滚动抢走（起手即锁定，松手还原）
    if (!seq && e.touches.length === 1 && cfg().fsGesture && !fsNow()) {
      if (isUiTarget(e.target)) return;
      var t = e.touches[0];
      var v = hitVideo(t.clientX, t.clientY);
      if (!v) return;
      var cont = TVG.Locator.containerFor(v);
      if (!cont) return;
      var r = cont.getBoundingClientRect();
      if (r.width <= 0) return;
      var rel = (t.clientX - r.left) / r.width;
      var half = clamp(cfg().fsEdgePercent || 0, 0, 80) / 200;
      if (rel >= 0.5 - half && rel <= 0.5 + half) {
        cont.classList.add('tvg-grab');
        fsGrab = cont;
      }
    }
  }

  // 松手后解除临时锁定
  function releaseGrab() {
    if (fsGrab) {
      try { fsGrab.classList.remove('tvg-grab'); } catch (e) {}
      fsGrab = null;
    }
  }

  function onTouchMove(e) {
    // 与 pointermove 双保险：单指有位移就取消长按判定，并刷新记录的触点位置。
    // Android 上 touch 事件最可靠，用它兜住 pointer 事件可能丢失的情况
    // （否则长按会在拖动过程中误触发，见 lpTimer 里的说明）。
    if (seq && seq.pointers.size === 1 && e.touches && e.touches.length === 1) {
      var t = e.touches[0];
      var mvx = t.clientX - seq.sx, mvy = t.clientY - seq.sy;
      if (!seq.moved && Math.hypot(mvx, mvy) > 8) {
        seq.moved = true;
        clearTimeout(seq.lpTimer);
      }
      var q0 = null;
      seq.pointers.forEach(function (z) { if (!q0) q0 = z; });
      if (q0) { q0.x = t.clientX; q0.y = t.clientY; }
    }
    // 手势锁定后拦截后续滚动；其余情况放行（页面正常滚动）
    if (seq && seq.engaged && e.cancelable) e.preventDefault();
  }

  // 页面失焦/切后台时兜底复位：这类情况 pointerup 可能收不到，
  // 残留的 seq 会让下一次触摸被当成"第二根手指"→ 直接进 instant4x。
  function resetSeq() {
    if (!seq) return;
    clearTimeout(seq.lpTimer);
    clearTimeout(seq._seekTimer);
    if (seq.mode === 'longpress' || seq.instant4x) {
      try { setRate(seq.video, seq.userRate); } catch (e) {}
    }
    TVG.Toast.hide();
    releaseGrab();
    seq = null;
  }

  function onContext(e) {
    if (seq && seq.pointers.size > 0 && cfg().longPress4x) e.preventDefault();
  }

  // 屏蔽站点/浏览器自带的"双击进全屏"——网页里双击往往同时被浏览器当作
  // 全屏快捷键，导致我们的"双击左/右快退快进"被抢走或两个动作叠加。
  // 用 dblclick 的捕获阶段 + preventDefault 拦下（不阻断我们自己的指针逻辑）。
  function onDblClick(e) {
    if (!cfg().blockDblFs) return;
    var v = hitVideo(e.clientX, e.clientY);
    if (!v) return;
    if (isUiTarget(e.target)) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  }

  // ===== 手势动作 =====

  // 进度拖动。两种模式（c.seekRealtime）：
  //   默认 false —— 非实时：拖动过程中只预览目标时间、不写 currentTime，
  //                 松手才跳转。避免边拖边 seek 让流媒体反复缓冲、画面闪烁。
  //   true      —— 实时：节流 120ms 写入 currentTime，画面跟随手指。
  function seekTo(s, dx) {
    var v = s.video;
    if (!isFinite(v.duration)) { TVG.Toast.show('直播流，无法调整进度', false, 0, s.rect, s.cont); return; }
    // 按总时长百分比调节，非线性：滑满半屏宽 = seekMaxPercent%
    var ratio = Math.pow(clamp(Math.abs(dx) / (s.rect.width * 0.5), 0, 1), cfg().seekCurve);
    var percent = ratio * cfg().seekMaxPercent;
    var sec = Math.sign(dx) * (percent / 100) * v.duration;
    var t = clamp(s.baseTime + sec, 0, v.duration - 0.1);
    s._pendingSeek = t;
    var label = (dx > 0 ? '快进 +' : '快退 -') + percent.toFixed(1) + '% · ' + fmt(t) + ' / ' + fmt(v.duration);

    if (cfg().seekRealtime) {
      if (!s._seekTimer) {
        s._seekTimer = setTimeout(function () {
          s._seekTimer = null;
          if (s._pendingSeek != null && s.video.isConnected) {
            try { s.video.currentTime = s._pendingSeek; } catch (err) {}
          }
        }, 120);
      }
      TVG.Toast.show(label, false, 0, s.rect, s.cont);
    } else {
      TVG.Toast.show(label + ' · 松手生效', false, 0, s.rect, s.cont);
    }
  }

  // 松手时提交进度跳转；返回实际落点，无待提交则返回 null。
  // 实时模式下也走这里——补上最后一个节流窗口内尚未落地的位置。
  function commitSeek(s) {
    if (!s || s._pendingSeek == null) return null;
    var t = s._pendingSeek;
    s._pendingSeek = null;
    if (!s.video || !s.video.isConnected) return null;
    try { s.video.currentTime = t; } catch (e) {}
    return t;
  }

  function nudgeSeek(v, sec, rect, cont) {
    if (!isFinite(v.duration)) return;
    try {
      v.currentTime = clamp(v.currentTime + sec, 0, v.duration - 0.1);
      TVG.Toast.show((sec > 0 ? '快进 +' : '快退 ') + sec + 's · ' + fmt(v.currentTime) + ' / ' + fmt(v.duration), false, 0, rect, cont);
    } catch (err) {}
  }

  function setSpeedRel(s, dx) {
    var step = cfg().speedStep || 0.25;
    var raw = s.baseRate + (dx / (s.rect.width || 1)) * 4;
    var speed = clamp(Math.round(raw / step) * step, 0.25, 4);
    speed = Math.round(speed * 100) / 100;
    if (speed === s.video.playbackRate) return;
    setRate(s.video, speed);
    TVG.Toast.show('倍速 ' + speed + 'x', true, 0, s.rect, s.cont);
  }

  function setVolumeRel(s, dy) {
    var v = clamp(s.baseVol - (dy / (s.rect.height || 1)) * cfg().volGain, 0, 1);
    try {
      s.video.volume = v;
      if (s.video.muted && v > 0) s.video.muted = false;
    } catch (err) {}
    TVG.Toast.show('音量 ' + Math.round(v * 100) + '%', true, 0, s.rect, s.cont);
  }

  function setBrightnessRel(s, dy) {
    var b = clamp(s.baseBright - (dy / (s.rect.height || 1)) * cfg().brightGain, 0.1, 1);
    brightnessMap.set(s.video, b);
    // 视频隐藏（canvas 渲染播放器）时滤镜要作用在可见的画布/容器上，
    // 否则给隐藏 video 加滤镜肉眼不可见
    var target = s.video;
    try {
      if (s.video.clientWidth === 0 || s.video.clientHeight === 0) {
        var cand = null;
        if (s.cont && s.cont.querySelector) cand = s.cont.querySelector('canvas');
        target = cand || s.cont || s.video;
      }
    } catch (e) {}
    try { target.style.filter = 'brightness(' + b + ')'; } catch (err) {}
    TVG.Toast.show('亮度 ' + Math.round(b * 100) + '%', true, 0, s.rect, s.cont);
  }

  // 中间窄带纵向滑动 → 全屏切换
  // 方向（默认）：下滑进全屏、上滑退出；c.fsReverse 反转
  // 位移越过 fsThreshold 后立即触发一次并锁定（fsDone），避免来回抖动反复切换
  function fsSwipe(s, dy) {
    var c = cfg();
    var th = c.fsThreshold || 40;
    if (s.fsDone) return;
    if (Math.abs(dy) < th) {
      // 未过阈值：给方向性提示，明确"还要滑多少"
      var need = c.fsReverse ? (dy < 0 ? '下滑进全屏' : '上滑退出全屏')
                             : (dy > 0 ? '下滑进全屏' : '上滑退出全屏');
      TVG.Toast.show(need + ' · ' + Math.abs(Math.round(dy)) + '/' + th, false, 0, s.rect, s.cont);
      return;
    }
    var down = dy > 0;                       // 下滑
    var wantEnter = c.fsReverse ? !down : down; // 是否需要"进入全屏"
    var isFs = fsNow();
    var act = wantEnter ? 'enter' : 'exit';
    // 已在目标状态时不再重复触发（如已全屏还下滑"进全屏"）
    if ((act === 'enter' && isFs) || (act === 'exit' && !isFs)) {
      s.fsDone = true;
      TVG.Toast.show(act === 'enter' ? '已全屏' : '已退出全屏', false, 800, s.rect, s.cont);
      return;
    }
    s.fsDone = true;
    var ok = toggleFullscreen(s, act === 'enter');
    TVG.Toast.show(
      ok ? (act === 'enter' ? '进入全屏' : '退出全屏') : '本站不支持手势全屏',
      false, ok ? 800 : 1500, s.rect, s.cont);
  }

  // ===== 注册与初始化 =====

  // 注册视频。视频可见时按其尺寸判定；不可见（0 尺寸）时按容器尺寸判定——
  // 兼容 canvas 渲染型播放器（video 隐藏、画面画在 canvas 上）。
  // 每次失败都记录原因（诊断用），绝不抛异常。
  function register(video) {
    attempts++;
    try {
      if (has(video)) return true;
      if (!video.isConnected) { lastReject = '已脱离'; return false; }
      var vw = video.clientWidth, vh = video.clientHeight;
      var sized = vw >= 120 && vh >= 60;
      var cont = TVG.Locator.containerFor(video);
      if (!cont) { lastReject = '无容器'; return false; }
      if (!sized) {
        // 隐藏视频必须是"真媒体"（有元数据/时长）才接管，避免误接管装饰性视频
        var hasMedia = video.readyState > 0 || (isFinite(video.duration) && video.duration > 0);
        if (!hasMedia) { lastReject = '隐藏且无媒体'; return false; }
        var r = cont.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) {
          lastReject = '尺寸不符 v=' + vw + 'x' + vh + ' c=' + Math.round(r.width) + 'x' + Math.round(r.height);
          return false;
        }
      }
    registry.push({ v: video, c: cont });
    // touch-action: pan-y —— 纵向原生滚动保留，横向交给手势
    cont.setAttribute('data-tvg-container', '');
    updateFsClass();
    lastReject = '';
      // 首个视频注册时给一次性提示（可在设置关闭），便于确认引擎已工作
      if (registry.length === 1 && cfg().hintOnAttach) {
        try {
          TVG.Toast.show('TVG 手势已启用', false);
        } catch (e) {}
      }
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[TVG] video registered, total =', registry.length, sized ? '' : '(hidden, container-sized)', video);
      }
      return true;
    } catch (err) {
      lastReject = '异常:' + (err && err.message ? String(err.message).slice(0, 40) : 'unknown');
      return false;
    }
  }

  function has(video) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].v === video) return true;
    }
    return false;
  }

  function prune() {
    for (var i = registry.length - 1; i >= 0; i--) {
      if (!registry[i].v.isConnected) registry.splice(i, 1);
    }
  }

  // 未注册视频的实时参数（诊断用）：尺寸/就绪状态/时长
  function unregInfo() {
    try {
      var it = TVG.Locator.videos(document);
      var s = it.next();
      while (!s.done) {
        var v = s.value;
        var taken = false;
        for (var i = 0; i < registry.length; i++) {
          if (registry[i].v === v) { taken = true; break; }
        }
        if (!taken) {
          return Math.round(v.clientWidth) + 'x' + Math.round(v.clientHeight) +
            ' rs' + (v.readyState || 0) +
            ' dur' + Math.round(v.duration > 0 && isFinite(v.duration) ? v.duration : 0) +
            (v.isConnected ? '' : ' 脱离');
        }
        s = it.next();
      }
    } catch (e) {}
    return '';
  }

  function init() {
    if (inited) return;
    inited = true;
    // 全部 document 捕获阶段：先于站点脚本收到事件
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('dblclick', onDblClick, true);
    // 全屏状态变化 → 更新容器的 touch-action 策略
    document.addEventListener('fullscreenchange', updateFsClass, true);
    document.addEventListener('visibilitychange', function () { if (document.hidden) resetSeq(); }, true);
    window.addEventListener('blur', resetSeq, true);
    window.addEventListener('resize', updateFsClass, true);

    // 统计接口（popup 诊断用，仅顶层文档响应）
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || msg.type !== 'tvg:stats') return;
        prune();
        // 深度扫描计数（含 shadow DOM），用于区分"视频在闭包 shadow 里"
        var deep = 0;
        try {
          var it = TVG.Locator.videos(document);
          var s = it.next();
          while (!s.done) { deep++; s = it.next(); }
        } catch (e) {}
        sendResponse({
          videos: registry.length,
          rawVideos: document.querySelectorAll('video').length,
          deepVideos: deep,
          iframes: document.querySelectorAll('iframe').length,
          reject: lastReject,
          attempts: attempts,
          unreg: unregInfo(),
          host: location.host,
          top: window.top === window
        });
      });
    }
  }

  return {
    register: register,
    has: has,
    prune: prune,
    count: function () { prune(); return registry.length; },
    refreshFullscreen: updateFsClass,
    init: init
  };
})();
