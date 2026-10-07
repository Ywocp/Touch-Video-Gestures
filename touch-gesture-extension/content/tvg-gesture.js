// 手势引擎：window 捕获统一接收 + 触点几何路由
// 设计要点：
//   1. 不在播放器容器上绑事件，而在 window 捕获阶段统一接收（事件流最前端，
//      配合 document_start 先于页面脚本注册）——部分站点（如 Pornhub）的播放器
//      脚本会在自身节点层拦截/停止传播触摸事件，容器级监听可能根本收不到。
//   2. 触摸起手时按"触点落在哪个视频的矩形内"路由到该视频（取最小命中矩形），
//      天然支持同页多视频：点到哪个就操作哪个。
//   3. 视频区域内的触摸由本扩展全权处理：网站脚本收不到该触摸的事件流
//      （详见下方「与网站脚本的事件隔离」）。
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
  var liveTouches = 0;        // 当前按在屏幕上的触点数（touchstart/touchend 维护，多指判定兜底）
  var mouseCaptured = false;  // 鼠标序列已被我们接管（mousedown 命中视频后，后续 move/up 一并切断）
  var live = true;            // 是否激活（main.js 在 storage 就绪后按「总开关 + 域名禁用」设置）
  var inited = false;

  // 手势引擎是否应当工作：激活标志 + 用户总开关。
  // 与「监听器注册」解耦 —— 监听器在 document_start 就绪（保证事件隔离的注册顺序），
  // 但在禁用域名/总开关关闭时不产生任何行为（不拦事件、不响应手势）。
  function isActive() { return live && !!cfg().enabled; }
  function setActive(v) {
    live = !!v;
    if (!live) resetSeq();     // 从工作态切到停用：复位进行中的手势（恢复倍速/清除提示）
  }

  // 滑动一票否决阈值（px）：本次触摸的位移一旦达到它，就认定"这是滑动手势"，
  // 长按资格永久作废 —— 不是"长按触发后再退出"，而是从源头保证长按绝不发生。
  // 取 5px：大于长按时的自然微抖（1~3px），小于旧容差 8px（拖动起步的常见位移会落在 5~8px 之间）。
  var SLIDE_PX = 5;

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

  // 取序列中的第一个触点（多处判定复用）
  function firstPoint() {
    var q = null;
    if (seq) seq.pointers.forEach(function (z) { if (!q) q = z; });
    return q;
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
      target: e.target,      // 起始触点目标：长按生效时向网站派发 cancel 事件（中止其自有手势）
      firstId: e.pointerId,  // 首个指针 id（合成 cancel 事件用）
      ptype: e.pointerType, // 序列的指针类型：多指手势要求同类型（都是 touch），并用于识别双路重复事件
      t0: Date.now(),       // 序列开始时刻（识别"双路重复事件"的时间窗）
      mode: null,        // seek | scroll | speed | volume | brightness | longpress | none
      engaged: false,
      done: false,
      instant4x: false,
      speedAdjusted: false, // 本次序列是否真调过倍速（双指 speed 拖动）；没调过才在松手时恢复原速
      moved: false,      // 本次触摸是否已滑动（位移 ≥SLIDE_PX）——一票否决长按，永久生效
      lpHinted: false,   // 长按锁定后是否已提示过"松手后可拖动"
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
        // 长按判定：本次触摸必须"从未滑动过"。三重检查，任一失败即永久否决——
        //   ① seq.moved 标志：任何移动事件（pointermove / touchmove）到位移 ≥SLIDE_PX 时置位，
        //      置位即取消定时器；动态置位后这里的检查是兜底（防事件竞态）；
        //   ② 用最后记录的触点位置复核位移（防个别环境 move 事件送不到）；
        //   ③ 只要滑动迹象成立，就不再有任何"事后补救"的余地 —— 长按从不出现，
        //      而不是"出现后再退出"（用户视角：拖动时绝不能闪出倍速）。
        var q = firstPoint();
        if (!q || seq.moved) return;
        if (Math.hypot(q.x - seq.sx, q.y - seq.sy) > SLIDE_PX) { seq.moved = true; return; }
        var rate = c.longPressRate || 4;
        seq.mode = 'longpress';
        seq.engaged = true;
        setRate(seq.video, rate);
        notifySiteCancel();   // 向网站派发 cancel：中止它自己可能正在进行的手势/长按
        TVG.Toast.show(rate + 'x 倍速（松开恢复）', true, 0, seq.rect, seq.cont);
      }, c.longPressMs);
    }
  }

  function onPointerDown(e) {
    if (!isActive()) return;
    var c = cfg();
    if (e.pointerType === 'mouse' && !c.mouseSupport) { releaseGrab(); return; }
    if (isUiTarget(e.target)) { releaseGrab(); return; }

    if (seq && seq.pointers.size > 0) {
      // 已有序列时的 pointerdown：先甄别这是不是"真实的第二根手指"。
      // 两类假双指会把单指拖动误判成双指倍速（实测都会发生，必须挡掉）：
      //   ① 双路重复事件：个别模拟器把同一次触摸同时发成 mouse + touch 两路
      //      pointer 流，几乎同时到达、类型不同 → 忽略后到的那一路；
      //   ② 残留序列：上一次 pointerup 丢失导致 seq 没清，新触摸被当成第二指。
      //      客观判据：全新触摸会话的第一根手指 isPrimary === true。
      var sameType = (e.pointerType === seq.ptype);
      var fresh = (Date.now() - (seq.t0 || 0)) < 200;
      if (!sameType && fresh) { stopSite(e); return; }   // ① 双路重复 → 忽略第二路
      var realSecond = sameType && e.pointerType === 'touch' &&
        (e.isPrimary === false ||
         (typeof e.isPrimary !== 'boolean' && liveTouches >= 2));
      if (!realSecond) {
        resetSeq();                                // ② 残留 → 清理后按全新触摸处理
      } else {
        // 第二指必须落在同一视频上
        var hit = hitVideo(e.clientX, e.clientY);
        if (!hit || hit !== seq.video) { stopSite(e); return; }
        clearTimeout(seq.lpTimer);
        stopSite(e);                               // 该触摸归我们接管：网站不再收到它的事件流
        if (seq.mode === 'longpress') {
          setRate(seq.video, seq.userRate);
          TVG.Toast.hide();
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
    }

    var v = hitVideo(e.clientX, e.clientY);
    if (!v) { releaseGrab(); return; }
    startSequence(e, v);
    seq.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopSite(e);   // 视频区域内的触摸由我们全权处理：切断网站脚本的事件流
  }

  // 单指移动的统一处理。pointermove 与 touchmove 两条通道都调用它：
  //   - 双通道同时到达时天然幂等（判定全部基于相对起点的绝对位移，不依赖增量）；
  //   - pointer 事件在个别环境（模拟器/合成事件）可能丢失，touchmove 兜底后
  //     手势依然完整（长按退出、进度拖动不再依赖单一路径）。
  function handleSingleMove(x, y) {
    if (!seq || seq.done) return;
    var c = cfg();
    var dx = x - seq.sx;
    var dy = y - seq.sy;
    // 同步记录触点位置：长按定时器要用它复核位移（双保险之一）
    var q0 = firstPoint();
    if (q0) { q0.x = x; q0.y = y; }
    // 滑动一票否决：位移达到 SLIDE_PX 即认定"本次触摸是滑动"，
    // 长按资格永久作废（定时器立即取消，且 moved 标志让任何残余回调也不可能触发）。
    // 拖动起步阶段的任何细微移动都会走到这里 —— 500ms 后绝无长按冒出的可能。
    if (!seq.moved && Math.hypot(dx, dy) > SLIDE_PX) {
      seq.moved = true;
      clearTimeout(seq.lpTimer);
    }
    // 赢家锁定（对标 PiliPlus 的手势仲裁：赢家通吃）——长按已生效，本次触摸
    // 就锁定为长按：移动不再切换为拖动。旧设计"长按后拖动再接管"让一个触摸
    // 串了两个动作，正是"长按倍速的同时又滑动了进度条"的根源。
    // 只提醒一次如何真正拖动（松手重按），避免用户困惑。
    if (seq.mode === 'longpress') {
      if (Math.hypot(dx, dy) >= c.moveThreshold && !seq.lpHinted) {
        seq.lpHinted = true;
        TVG.Toast.show('长按倍速中 · 松手后可拖动进度', false, 1200, seq.rect, seq.cont);
      }
      return;
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
  }

  function onPointerMove(e) {
    if (!isActive()) return;
    if (!seq) return;
    var p = seq.pointers.get(e.pointerId);
    if (!p) return;
    stopSite(e);          // 归属我们的指针：网站脚本不再收到其事件流
    if (seq.done) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (seq.pointers.size === 1) {
      handleSingleMove(e.clientX, e.clientY);
    } else if (seq.pointers.size === 2) {
      var c = cfg();
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
    if (e && e.__tvgSynthetic) return;   // 忽略我们派发的合成 cancel（否则会误清自己的序列）
    if (!isActive()) return;
    if (!seq) return;
    if (!seq.pointers.has(e.pointerId)) return;
    stopSite(e);                         // 与 down/move 一致：切断事件流
    seq.pointers.delete(e.pointerId);
    clearTimeout(seq.lpTimer);
    if (seq.pointers.size === 0) {
      clearTimeout(seq._seekTimer);
      var landed = (seq.mode === 'seek') ? commitSeek(seq) : null;
      if (seq.instant4x && !seq.speedAdjusted) setRate(seq.video, seq.userRate);
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
      var rest = firstPoint();
      seq.sx = rest.x;
      seq.sy = rest.y;
      // instant4x（双指瞬时 4x）只在双指期间有效：掉到单指且未真调过倍速时
      // 立即恢复原速。注意不要用当前 playbackRate 覆盖 userRate——4x 生效中
      // 会把 4 记成"用户基准速率"，最后松手时恢复成 4x 卡住。
      if (seq.instant4x) {
        if (!seq.speedAdjusted) setRate(seq.video, seq.userRate);
        seq.instant4x = false;
      }
      seq.mode = null;
      seq.done = false;
    }
  }

  function onTouchStart(e) {
    if (!isActive()) return;
    liveTouches = (e.touches && e.touches.length) || 0;
    var t0 = e.touches && e.touches[0];
    var uiT = isUiTarget(e.target);
    var hit0 = (t0 && !uiT) ? hitVideo(t0.clientX, t0.clientY) : null;
    // 视频区域内的触摸由我们全权接管：立即切断网站脚本（它的长按/滑动逻辑不从
    // 这个触摸起步）。tap 合成的 click 不受影响，网站点击交互保留。
    if (hit0) stopSite(e);
    // 序列进行中，第二指落在同一视频上：吃掉默认行为（防页面滚动/缩放）
    if (seq && seq.pointers.size >= 1 && e.touches.length >= 2 && e.cancelable && hit0) {
      if (hit0 === seq.video) e.preventDefault();
      return;
    }
    // 非全屏时，触点落在中间全屏带：临时锁住容器的 pan-y，
    // 保证纵向滑动的前几帧不被浏览器当作页面滚动抢走（起手即锁定，松手还原）
    if (!seq && e.touches.length === 1 && cfg().fsGesture && !fsNow()) {
      if (uiT || !hit0) return;
      var cont = TVG.Locator.containerFor(hit0);
      if (!cont) return;
      var r = cont.getBoundingClientRect();
      if (r.width <= 0) return;
      var rel = (t0.clientX - r.left) / r.width;
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

  // ===== 与网站脚本的事件隔离 =====
  // 目标：视频区域内的触摸由我们全权处理 —— 网站脚本收不到该触摸的
  // pointer/touch/mouse 事件流（它的长按、滑动、拖动、自绘菜单都不会响应）。
  //   · 监听挂 window 捕获（事件流最前端）+ document_start 抢注册顺序：
  //     网站的任何监听都在我们之后执行，stopImmediatePropagation 可以全断；
  //   · pointer 与 touch 之外，mouse 家族同样拦截（桌面鼠标 + 移动端合成 mouse）；
  //   · 只有"事件流"被切断；tap 合成的 click 照常派发给网站，
  //     网站正常的点击交互（显示控制条等）不受影响。
  function stopSite(e) {
    if (!e) return;
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.stopPropagation) e.stopPropagation();
  }

  // ---- mouse 家族拦截：桌面鼠标与「触摸合成的 mouse 事件」都要切断，
  //      否则网站的 mousedown/mousemove/mouseup 监听仍会跟着响应 ----
  function onMouseDown(e) {
    if (!isActive()) return;
    var v = hitVideo(e.clientX, e.clientY);
    if (!v || isUiTarget(e.target)) return;   // 控件区域（如网站进度条）放行
    mouseCaptured = true;
    stopSite(e);
  }
  function onMouseMove(e) {
    if (!isActive() || !mouseCaptured) return;
    stopSite(e);
  }
  function onMouseUp(e) {
    if (!isActive() || !mouseCaptured) return;
    stopSite(e);
    mouseCaptured = false;
  }
  function onAuxClick(e) {
    if (!isActive()) return;
    var v = hitVideo(e.clientX, e.clientY);
    if (v && !isUiTarget(e.target)) stopSite(e);
  }

  // 长按生效时向网站派发合成 cancel：规范实现的播放器库（Video.js 等）收到
  // pointercancel/touchcancel 会中止自己正在进行的手势 —— 这是压制"长按触发
  // 网站自有手势"的第二条路径（第一条是 stopSite 切断事件流）。
  // 合成事件带 __tvgSynthetic 标记，我们自己的监听器据此忽略它（否则会误清序列）。
  function notifySiteCancel() {
    var t = seq && seq.target;
    if (!t || typeof t.dispatchEvent !== 'function') return;
    try {
      var pe = new PointerEvent('pointercancel', {
        bubbles: true, cancelable: true, composed: true,
        pointerId: seq.firstId || 1, pointerType: seq.ptype || 'touch',
        isPrimary: true, clientX: seq.sx, clientY: seq.sy
      });
      pe.__tvgSynthetic = true;
      t.dispatchEvent(pe);
    } catch (e1) {}
    try {
      // 兼容以 Touch 事件工作库：非 TouchEvent 构造，但补齐 touches 类属性
      var te = new Event('touchcancel', { bubbles: true, cancelable: true });
      te.touches = []; te.targetTouches = []; te.changedTouches = [];
      te.__tvgSynthetic = true;
      t.dispatchEvent(te);
    } catch (e2) {}
  }

  function onTouchMove(e) {
    if (!isActive()) return;
    liveTouches = (e.touches && e.touches.length) || 0;
    if (seq) stopSite(e);   // 我们接管的触摸：网站脚本不再收到其事件流
    // 与 pointermove 走同一条处理路径：单指时把 touchmove 也喂给统一处理函数。
    // Android 上 touch 事件最可靠；pointer 事件在个别环境可能丢失——
    // 双通道同时到达时处理天然幂等，丢任何一路手势都完整。
    if (seq && seq.pointers.size === 1 && e.touches && e.touches.length === 1) {
      handleSingleMove(e.touches[0].clientX, e.touches[0].clientY);
    }
    // 手势锁定后拦截后续滚动；其余情况放行（页面正常滚动）
    if (seq && seq.engaged && e.cancelable) e.preventDefault();
  }

  // touch 计数维护：isPrimary 不可用的环境（老内核）用它兜底判断当前有几指按着
  function onTouchCount(e) {
    if (e && e.__tvgSynthetic) return;   // 忽略合成 cancel
    if (!isActive()) return;
    if (seq) stopSite(e);                // 与 down/move 保持一致
    liveTouches = (e.touches && e.touches.length) || 0;
  }

  // 页面失焦/切后台时兜底复位：这类情况 pointerup 可能收不到，
  // 残留的 seq 会让下一次触摸被当成"第二根手指"→ 直接进 instant4x。
  function resetSeq() {
    mouseCaptured = false;
    if (!seq) return;
    clearTimeout(seq.lpTimer);
    clearTimeout(seq._seekTimer);
    // 长按/双指 4x 生效中要恢复原速；但真调过倍速（speed 拖动）的结果保留
    if (seq.mode === 'longpress' || (seq.instant4x && !seq.speedAdjusted)) {
      try { setRate(seq.video, seq.userRate); } catch (e) {}
    }
    TVG.Toast.hide();
    releaseGrab();
    seq = null;
  }

  function onContext(e) {
    // 屏蔽两类"长按菜单"：
    //   ① 系统菜单（Android 长按 video 的媒体菜单、文本选择等）；
    //   ② 网站自绘菜单（如 Eporner Player 的 "Copy video URL" 菜单——由网站
    //      自己的 contextmenu 监听弹出）。
    // 关键：仅 preventDefault 只能挡下"默认行为"，网站监听照样收到事件、
    // 照样弹它自己的菜单 —— 必须同时 stopSite 切断事件流。此前的疏漏正在于此。
    if (!isActive()) return;
    if (!cfg().longPress4x) return;
    if (seq && seq.pointers.size > 0) {
      stopSite(e);
      if (e.cancelable) e.preventDefault();
      return;
    }
    var v = hitVideo(e.clientX, e.clientY);
    if (v) {
      stopSite(e);
      if (e.cancelable) e.preventDefault();
    }
  }

  // 屏蔽站点/浏览器自带的"双击进全屏"——网页里双击往往同时被浏览器当作
  // 全屏快捷键，导致我们的"双击左/右快退快进"被抢走或两个动作叠加。
  // 用 dblclick 的捕获阶段 + preventDefault 拦下（不阻断我们自己的指针逻辑）。
  function onDblClick(e) {
    if (!isActive()) return;
    if (!cfg().blockDblFs) return;
    var v = hitVideo(e.clientX, e.clientY);
    if (!v) return;
    if (isUiTarget(e.target)) return;
    if (e.cancelable) e.preventDefault();
    stopSite(e);
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
    s.speedAdjusted = true;   // 真调过倍速 → 松手时保留结果，不恢复原速
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
      // 首个视频注册时给一次性提示（可在设置关闭），便于确认引擎已工作。
      // 带版本号：用户一眼能确认页面里跑的是哪一版内容脚本——
      // 扩展更新后已打开的页面仍可能驻留旧脚本，刷新前不会有新行为。
      if (registry.length === 1 && cfg().hintOnAttach) {
        try {
          var ver = '';
          try { ver = chrome.runtime.getManifest().version; } catch (e2) {}
          TVG.Toast.show('TVG v' + (ver || '?') + ' 手势已启用', false);
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
    // 全部挂 window 捕获：事件流的最前端（window → document → … → target），
    // 配合 document_start 抢到的注册顺序，构成最外层的"事件收割器"——
    // 网站的任何监听（window/document/元素，捕获或冒泡）都在我们之后执行，
    // stopSite 才能真正做到全断。
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    // mouse 家族：桌面鼠标与移动端合成 mouse 事件同样切断（网站仍在用它们）
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('auxclick', onAuxClick, true);
    window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', onTouchCount, { capture: true, passive: true });
    window.addEventListener('touchcancel', onTouchCount, { capture: true, passive: true });
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('dblclick', onDblClick, true);
    // 以下事件不属于竞争事件，按规范挂在对应对象上
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
    setActive: setActive,
    init: init
  };
})();
