// Zone 区域/注册中心：视频注册表 + 容器 touch-action + 中央全屏带（预置抓取层）
// 职责边界：
//   · 谁被接管（register/has/prune/count/遍历）、触点落在哪个视频（hitVideo）
//   · 容器上的类名状态：.tvg-fs（全屏时 touch-action:none）
//   · 中央全屏带 .tvg-band：预置的真实元素（自带 touch-action:none），
//     触摸从第一帧起就归脚本——详见 ensureBand 注释（v1.0.8 起的核心机制）
window.TVG = window.TVG || {};
TVG.Zone = (function () {
  'use strict';

  var clamp = TVG.clamp;
  var cfg = TVG.cfg;

  var registry = [];          // 已注册视频：{ v: video, c: container, band: 预置带元素|null }
  var lastReject = '';        // 最近一次注册失败原因（诊断用）
  var attempts = 0;           // 注册尝试次数（诊断用）

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

  // 全屏状态（供手势 regionOf 使用；iframe 内全屏 standard API 为 null，用视口回退）
  function fsNow() {
    return !!document.fullscreenElement || viewportIsScreen();
  }

  // 全屏状态下移除容器的 touch-action:pan-y（纵向滚动无意义，且会抢走
  // 音量/亮度手势的前几帧）——用 .tvg-fs 类切换，退出全屏自动恢复
  function updateFsClass() {
    var fs = fsNow();
    for (var i = 0; i < registry.length; i++) {
      var c = registry[i].c;
      if (!c || !c.classList) continue;
      if (fs) c.classList.add('tvg-fs');
      else c.classList.remove('tvg-fs');
    }
    refreshBands();   // 全屏切换 → 中央全屏带同步隐藏 / 恢复
  }

  // ===== 中央全屏带：预置抓取层（v1.0.8）=====
  // 为什么必须"预置"：touch-action 在触摸开始时就被浏览器求值并锁定——进入
  // touchstart 处理器之后再加类对"已经开始的那次触摸"无效，顶页下滑时浏览器
  // 照样拿手势去触发下拉刷新（用户实测）。因此把中央窄带做成一个自带
  // touch-action:none 的真实元素，常驻在视频容器里：
  //   · 触摸落在它上面 → 浏览器从第一帧起就没有滚动 / 下拉刷新资格；
  //   · 窄带以外的区域不预置、不接管，浏览器行为（页面滚动等）完全照旧；
  //   · 全屏时移除（容器已挂 .tvg-fs = touch-action:none，无需此层）；
  //   · 纵向留出容器底部一段（避开控制条）：控件照常命中、照常可用。
  function ensureBand(e) {
    var half = clamp(cfg().fsEdgePercent || 0, 0, 80) / 200; // 窄带半宽（0~0.4）
    var want = !!(TVG.isActive() && cfg().fsGesture && half > 0.02 && !fsNow());
    var b = e.band;
    if (!want) {
      if (b && b.parentNode) {
        try { b.parentNode.removeChild(b); } catch (err) {}
      }
      e.band = null;
      return;
    }
    if (!b || !b.isConnected) {
      b = document.createElement('div');
      b.className = 'tvg-band';
      b.setAttribute('aria-hidden', 'true');
      e.band = b;
    }
    if (b.parentNode !== e.c) {
      // 容器多为已定位的播放器外壳；个别是 static —— 注入 relative 作定位基准
      try {
        var pos = window.getComputedStyle ? getComputedStyle(e.c).position : '';
        if (pos === 'static') e.c.style.position = 'relative';
      } catch (err2) {}
      try { e.c.appendChild(b); } catch (err3) {}
    }
    // 取 0.1% 精度，避免浮点尘埃进入样式字符串
    var left = Math.round((0.5 - half) * 1000) / 10;
    var width = Math.round(half * 2 * 1000) / 10;
    b.style.left = left + '%';
    b.style.width = width + '%';
  }

  function refreshBands() {
    for (var i = 0; i < registry.length; i++) ensureBand(registry[i]);
  }

  function bandFor(video) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].v === video) return registry[i].band || null;
    }
    return null;
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

  function has(video) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].v === video) return true;
    }
    return false;
  }

  function prune() {
    for (var i = registry.length - 1; i >= 0; i--) {
      if (!registry[i].v.isConnected) {
        var b = registry[i].band;
        if (b && b.parentNode) {
          try { b.parentNode.removeChild(b); } catch (e) {}
        }
        registry.splice(i, 1);
      }
    }
  }

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
      registry.push({ v: video, c: cont, band: null });
      // touch-action: pan-y —— 纵向原生滚动保留，横向交给手势
      cont.setAttribute('data-tvg-container', '');
      updateFsClass();   // 内含 refreshBands：按当前设置同步中央全屏带
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

  // 未注册视频的实时参数（诊断用）：尺寸/就绪状态/时长
  function unregInfo() {
    try {
      var it = TVG.Locator.videos(document);
      var s = it.next();
      while (!s.done) {
        var v = s.value;
        if (!has(v)) {
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

  // popup 诊断数据（注册数 / 失败原因 / 未接管视频信息）
  function stats() {
    prune();
    return {
      videos: registry.length,
      reject: lastReject,
      attempts: attempts,
      unreg: unregInfo()
    };
  }

  return {
    register: register,
    has: has,
    prune: prune,
    count: function () { prune(); return registry.length; },
    hitVideo: hitVideo,
    updateFsClass: updateFsClass,
    fsNow: fsNow,
    refreshBands: refreshBands,
    bandFor: bandFor,
    stats: stats
  };
})();
