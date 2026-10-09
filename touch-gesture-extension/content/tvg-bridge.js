// Bridge 站点桥：一切"与站点打交道"的事集中在这里
//   · 事件切断（stopSite）与合成取消（notifySiteCancel）——「观察-切断」的出口
//   · 站点原生全屏：优先点击站点自己的全屏按钮（播放器适配表，声明式）
//   · 预置带轻点转发：修正命中测试伪影（抑制错误目标的原生 click + 按带下元素补发）
window.TVG = window.TVG || {};
TVG.Bridge = (function () {
  'use strict';

  // ===== 事件切断 =====
  // 「观察-切断」策略（v1.0.7）：点击归网站（观察期完整放行）、手势归我们
  // （成立瞬间切断 + 通知取消）。监听挂 window 捕获（事件流最前端）+ document_start
  // 抢注册顺序：网站的任何监听都在我们之后执行，stopImmediatePropagation 才能全断。
  function stopSite(e) {
    if (!e) return;
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.stopPropagation) e.stopPropagation();
  }

  // 长按/手势成立时向网站派发合成 cancel：规范实现的播放器库（Video.js 等）收到
  // pointercancel/touchcancel 会中止自己正在进行的手势和点击识别 —— 这是压制
  // "长按触发网站自有手势"的第二条路径（第一条是 stopSite 切断事件流）。
  // 合成事件带 __tvgSynthetic 标记，我们自己的监听器据此忽略它（否则会误清序列）。
  function notifySiteCancel(s) {
    if (s && s.remote) return;   // 跨帧转发的序列：站点从未见过这些触摸，无需通知
    var t = s && s.target;
    if (!t || typeof t.dispatchEvent !== 'function') return;
    try {
      var pe = new PointerEvent('pointercancel', {
        bubbles: true, cancelable: true, composed: true,
        pointerId: s.firstId || 1, pointerType: s.ptype || 'touch',
        isPrimary: true, clientX: s.sx, clientY: s.sy
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

  // ===== 站点原生全屏 =====
  // 播放器适配表（声明式）：手势全屏优先点击"站点自己的全屏按钮"——由站点的
  // 全屏逻辑接管，站点 UI（控制条/进度条/全屏状态类）随其自身状态正常工作；
  // 绕过站点直接调浏览器 API 会导致"进了全屏点不出进度条"（v1.0.9 修）。
  // 加新播放器 = 加一行；杂牌自研播放器走下面的通用回退模式。
  var PLAYER_UI = [
    { name: 'plyr',     fs: '[data-plyr="fullscreen"]' },
    { name: 'video.js', fs: '.vjs-fullscreen-control' },
    { name: 'jwplayer', fs: '.jw-icon-fullscreen' }
  ];
  var FS_FALLBACK = [
    '[class*="fullscreen" i][class*="btn" i]',
    '[class*="btn" i][class*="fullscreen" i]',
    'button[class*="fullscreen" i]',
    '[class*="fullscreen" i]',
    'button[aria-label*="fullscreen" i]', '[aria-label*="fullscreen" i]',
    '[title*="fullscreen" i]',
    'button[title*="全屏"]', '[aria-label*="全屏"]', '[title*="全屏"]'
  ];

  function findFsButton(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    var sels = [];
    for (var k = 0; k < PLAYER_UI.length; k++) sels.push(PLAYER_UI[k].fs);
    sels = sels.concat(FS_FALLBACK);
    for (var i = 0; i < sels.length; i++) {
      var list;
      try { list = scope.querySelectorAll(sels[i]); } catch (e1) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        if (r.width * r.height > 30000) continue;              // 排除整块容器 / 封面层
        if (el.querySelector && el.querySelector('video')) continue; // 不含视频元素的才算按钮
        return el;
      }
    }
    return null;
  }

  // 进入 / 退出全屏。首选"点击站点的全屏按钮"；站点没有按钮时回退
  // requestFullscreen API（旧行为）。
  function toggleFullscreen(s, enter) {
    var scope = enter ? s.cont : (document.fullscreenElement || s.cont);
    var btn = findFsButton(scope) || findFsButton(s.cont);
    if (btn) {
      try { btn.click(); return true; } catch (e0) {}
    }
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

  // ===== 预置带轻点转发（v1.0.9）=====
  // 带吃掉了命中测试：原生 click 的目标是"带"本身，网站的"点视频弹控制条"
  // 一类逻辑（校验 target 是视频 / 包裹层）收不到。处理：
  //   1) 轻点未成手势 → 先标记"抑制下一次带上原生 click"（目标错误）；
  //   2) 按带下的真实元素（elementFromPoint）补发一次正确的 click。
  // 不带手势冲突的一切交互由此保真（点按弹控制条、点按播放器按钮等）。
  var suppressBandClick = false;
  var suppressTimer = 0;

  function forwardBandTap(band, x, y) {
    var under = null;
    try {
      band.style.pointerEvents = 'none';
      under = document.elementFromPoint(x, y);
      band.style.pointerEvents = '';
    } catch (e0) { try { band.style.pointerEvents = ''; } catch (e1) {} }
    if (!under || under === band) return;
    suppressBandClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(function () { suppressBandClick = false; }, 800);
    try {
      var ev = new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, detail: 1
      });
      under.dispatchEvent(ev);
    } catch (e2) {}
  }

  function onClickCapture(e) {
    if (!suppressBandClick) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('.tvg-band')) return;   // 还不是"带上那次"原生 click → 保留标记
    suppressBandClick = false;
    clearTimeout(suppressTimer);
    stopSite(e);
  }

  return {
    stopSite: stopSite,
    notifySiteCancel: notifySiteCancel,
    findFsButton: findFsButton,
    toggleFullscreen: toggleFullscreen,
    forwardBandTap: forwardBandTap,
    onClickCapture: onClickCapture
  };
})();
