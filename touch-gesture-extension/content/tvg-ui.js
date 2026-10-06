// Toast 提示框（每个 frame 最多一个实例）
// 关键设计：
//   1. 全屏时挂载到 fullscreenElement 内（body 的子节点在全屏下不可见），随全屏切换搬家
//   2. 位置 = 视频矩形内的纵向百分比（可调），并自动避让播放器底部控制条
//   3. 字号可调；所有定位用内联样式（锚定视频而非视口）
window.TVG = window.TVG || {};
TVG.Toast = (function () {
  'use strict';

  var el = null;
  var hideTimer = null;

  function ensure() {
    var root = document.fullscreenElement || document.body || document.documentElement;
    if (!root) return null;
    if (el && el.isConnected) {
      if (el.parentNode !== root) root.appendChild(el); // 全屏切换后搬入正确根节点
      return el;
    }
    el = document.createElement('div');
    el.className = 'tvg-toast';
    root.appendChild(el);
    return el;
  }

  // 探测播放器底部控制条（进度条等）的顶部位置：0 表示未检测到
  function findControlBarTop(cont, anchor) {
    var best = 0;
    try {
      var cands = cont.querySelectorAll(
        '[class*="control" i],[class*="timeline" i],[class*="progress" i],[class*="scrub" i]');
      for (var i = 0; i < cands.length; i++) {
        var r = cands[i].getBoundingClientRect();
        if (r.width < 40 || r.height < 6 || r.height > anchor.height * 0.35) continue;
        if (r.width < anchor.width * 0.3) continue;               // 须为横向长条
        if (r.top < anchor.top + anchor.height * 0.55) continue;  // 须位于视频下半部
        if (best === 0 || r.top < best) best = r.top;
      }
    } catch (e) {}
    return best;
  }

  // anchor: 视频/容器矩形；cont: 容器元素（用于控制条避让探测）
  function show(text, sticky, ms, anchor, cont) {
    var t = ensure();
    if (!t) return;
    // 用 textContent 而非 innerHTML：兼容开启 Trusted Types 的站点
    t.textContent = text;

    var c = TVG.Settings || TVG.DEFAULTS;
    t.style.fontSize = (c.toastFont || 14) + 'px';
    var op = (typeof c.toastOpacity === 'number' ? c.toastOpacity : 86) / 100;
    t.style.background = 'rgba(20, 20, 24, ' + op + ')';

    var vw = innerWidth || 1, vh = innerHeight || 1;
    var pct = (typeof c.toastY === 'number') ? c.toastY : 50;
    var x, y;
    if (anchor && anchor.width > 4 && anchor.height > 4) {
      x = anchor.left + anchor.width / 2;
      y = anchor.top + anchor.height * pct / 100;
    } else {
      x = vw / 2;
      y = vh * pct / 100;
    }

    t.classList.add('tvg-show');
    clearTimeout(hideTimer);
    if (!sticky) hideTimer = setTimeout(hide, ms || c.toastMs || 900);

    // 先显示再测量高度（避让需要实际高度）
    var h = t.offsetHeight || 30;

    // 底部控制条避让：位置偏下且检测到进度条类元素时自动抬高
    if (anchor && pct >= 60 && cont) {
      var barTop = findControlBarTop(cont, anchor);
      if (barTop > 0 && y + h / 2 > barTop - 6) {
        y = barTop - 6 - h / 2;
      }
    }

    // 出界钳制 + 不超出视频底部
    x = Math.min(Math.max(x, vw * 0.15), vw * 0.85);
    y = Math.min(Math.max(y, h / 2 + 4), vh - h / 2 - 4);
    if (anchor && anchor.height > 4) {
      y = Math.min(y, anchor.bottom - h / 2 - 4);
    }

    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y) + 'px';
  }

  function hide() {
    if (el) el.classList.remove('tvg-show');
  }

  // 全屏切换时把提示框搬进/搬出 fullscreenElement
  document.addEventListener('fullscreenchange', function () {
    if (el && el.isConnected) ensure();
  }, true);

  return { show: show, hide: hide };
})();
