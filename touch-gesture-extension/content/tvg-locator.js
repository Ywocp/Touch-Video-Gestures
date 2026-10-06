// 视频发现与容器定位：不依赖站点类名，纯启发式，覆盖任意站点结构
window.TVG = window.TVG || {};
TVG.Locator = (function () {
  'use strict';

  function area(el) {
    var r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  // 深度遍历（含 shadow DOM）找出所有 video 元素
  function* videos(root, depth) {
    if (!root || (depth || 0) > 8) return;
    var list = [];
    try { list = root.querySelectorAll('video'); } catch (e) {}
    for (var i = 0; i < list.length; i++) yield list[i];
    var all = [];
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.shadowRoot) yield* videos(el.shadowRoot, (depth || 0) + 1);
    }
  }

  // 容器定位：从 video 向上爬，父级面积增幅 <=1.18 倍即继续（沿用原脚本思路），
  // 全屏时直接以 fullscreenElement 为容器
  function containerFor(video) {
    var fe = document.fullscreenElement;
    if (fe && fe.contains(video)) return fe;
    var best = video;
    var bestArea = area(video);
    var node = video.parentElement;
    if (bestArea <= 0) {
      // 视频不可见（0 尺寸，如 canvas 渲染播放器）：
      // 向上寻找第一个达到"播放器尺寸"（>=120x60）的祖先，跳过 0 尺寸包装层
      while (node && node !== document.body && node !== document.documentElement) {
        if (area(node) >= 7200) return node;
        node = node.parentElement;
      }
      return video.parentElement || video;
    }
    while (node && node !== document.body && node !== document.documentElement) {
      var a = area(node);
      if (a <= 0) { node = node.parentElement; continue; }
      if (a / bestArea > 1.18) break;
      best = node;
      bestArea = a;
      node = node.parentElement;
    }
    return best;
  }

  return { videos: videos, containerFor: containerFor };
})();
