// Overlay 覆盖层穿透（v1.1.7）：让盖在视频上的浮层广告「看得见、碰不到」
// ---------------------------------------------------------------------------
// 诉求：用户的任何触摸都不该落到广告上（误点跳转、长按弹出广告菜单等），
//       但广告本身要照常展示——隐藏 / 移除会触发站点的反广告检测（弹墙、停播）。
//
// 做法：给这类 iframe 打 pointer-events:none —— 浏览器命中测试直接跳过它，
//       触摸穿透到下层视频，父页 window 捕获就能收到事件（连跨帧转发都用不上）。
//       广告依旧加载、依旧可见、尺寸位置不变，站点检测不到任何异常。
//
// 判定（保守，宁可漏判也不误伤）：
//   · iframe 中心点落在已注册视频的矩形内（不在视频上就不管）；
//   · iframe 面积 < 视频面积 × 60%（过大 → 大概率是播放器本体 iframe，穿透会毁掉手势）；
//   · 同源 iframe 内若含 video → 不是广告，跳过。
// 不做域名黑名单：广告域名各家各变，靠尺寸/位置判据更耐用。
// 刷新时机：跟随 main.js 的视频扫描节奏（MutationObserver + 3s 兜底）+ 设置变更。
window.TVG = window.TVG || {};
TVG.Overlay = (function () {
  'use strict';

  var cfg = TVG.cfg;

  var passed = new WeakMap();   // iframe → 穿透前的 pointerEvents 原值（用于恢复）

  function rectOf(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  // 已接管视频的矩形（隐藏视频用容器矩形兜底，与 Zone.hitVideo 的口径一致）
  function videoRects() {
    var out = [];
    try {
      var it = TVG.Locator.videos(document);
      var s = it.next();
      while (!s.done) {
        var v = s.value;
        if (v && v.isConnected && TVG.Zone.has(v)) {
          var r = rectOf(v);
          if (!r || r.width * r.height <= 0) {
            var c = null;
            try { c = TVG.Locator.containerFor(v); } catch (e0) {}
            r = c ? rectOf(c) : null;
          }
          if (r && r.width > 0 && r.height > 0) out.push(r);
        }
        s = it.next();
      }
    } catch (e) {}
    return out;
  }

  // 该 iframe 是否算「盖在视频上的浮层」
  function isOverlay(ifr, vr) {
    var r = rectOf(ifr);
    if (!r || r.width < 40 || r.height < 30) return false;        // 太小（像素/追踪帧）
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < vr.left || cx > vr.right || cy < vr.top || cy > vr.bottom) return false;
    if (r.width * r.height > vr.width * vr.height * 0.6) return false;  // 过大 = 播放器本体
    try {
      var d = ifr.contentDocument;                                 // 同源才可读；跨源抛异常
      if (d && d.querySelector && d.querySelector('video')) return false;
    } catch (e) {}
    return true;
  }

  // 按当前开关状态同步全部 iframe。开关关闭 / 失活 / 不再命中 → 恢复原值。
  function refresh() {
    try {
      var on = !!(TVG.isActive() && cfg().overlayPass);
      var vrs = on ? videoRects() : [];
      var list = document.querySelectorAll('iframe');
      for (var i = 0; i < list.length; i++) {
        var ifr = list[i];
        var hit = false;
        for (var j = 0; j < vrs.length; j++) {
          if (isOverlay(ifr, vrs[j])) { hit = true; break; }
        }
        if (hit) {
          if (!passed.has(ifr)) {
            passed.set(ifr, ifr.style ? ifr.style.pointerEvents : '');
            try {
              ifr.style.pointerEvents = 'none';
              ifr.setAttribute('data-tvg-pass', '');
            } catch (e1) {}
          }
        } else if (passed.has(ifr)) {
          try { ifr.style.pointerEvents = passed.get(ifr) || ''; } catch (e2) {}
          try { ifr.removeAttribute('data-tvg-pass'); } catch (e3) {}
          passed.delete(ifr);
        }
      }
    } catch (err) {}
  }

  return { refresh: refresh };
})();
