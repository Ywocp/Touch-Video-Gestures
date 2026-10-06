// 入口：读设置 → 启发式发现视频 → 注册到手势引擎；MutationObserver 持续监听
(function () {
  'use strict';
  if (window.__TVG_INIT__) return;
  window.__TVG_INIT__ = true;

  TVG.Storage.get().then(function (cfg) {
    if (!cfg.enabled) return;
    var host = location.host || 'iframe';
    var disabled = (cfg.disabledSites || []).some(function (d) {
      return d && (host === d || host.endsWith('.' + d));
    });
    if (disabled) return;

    TVG.Settings = cfg;

    // document 级捕获监听 + 触点几何路由（先于站点脚本收到事件）
    TVG.Gestures.init();

    function scan() {
      var vs = TVG.Locator.videos(document);
      var next = vs.next();
      var now = Date.now();
      while (!next.done) {
        var v = next.value;
        if (!TVG.Gestures.has(v)) {
          if (v.clientWidth >= 120 && v.clientHeight >= 60) {
            // 可见视频：直接注册
            try { TVG.Gestures.register(v); } catch (e) {}
          } else {
            // 隐藏视频（可能是 canvas 渲染播放器）：每 5 秒最多尝试一次容器回退注册
            var last = Number(v.dataset.tvgHiddenRetry || 0);
            if (now - last > 5000) {
              v.dataset.tvgHiddenRetry = now;
              try { TVG.Gestures.register(v); } catch (e) {}
            }
          }
        }
        next = vs.next();
      }
      // 全屏状态可能随视口变化（伪全屏），每次扫描同步一次类名
      try { TVG.Gestures.refreshFullscreen(); } catch (e) {}
    }
    function scheduleScan() {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 250);
    }

    // 换页/动态插入监听（替代原脚本 2 秒轮询）
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    // 播放事件兜底：懒加载或后挂载的播放器在 媒体就绪/播放 时再扫
    document.addEventListener('play', scheduleScan, true);
    document.addEventListener('playing', scheduleScan, true);
    document.addEventListener('loadedmetadata', scheduleScan, true);
    document.addEventListener('durationchange', scheduleScan, true);
    addEventListener('resize', scheduleScan, true);
    document.addEventListener('fullscreenchange', scheduleScan, true);
    // 定时兜底扫描：覆盖"无 DOM 变化 / shadow 边界内创建 / 事件不冒泡"等盲区
    setInterval(scan, 3000);
    scan();

    // 自检：若页面明明有视频却没接管成功，主动提示（便于定位问题层）
    setTimeout(function () {
      var raw = document.querySelectorAll('video').length;
      var taken = TVG.Gestures.count();
      if (taken === 0 && raw > 0) {
        try {
          TVG.Toast.show('TVG：发现 ' + raw + ' 个视频但未接管，点扩展图标看诊断', false, 4000);
        } catch (e) {}
      }
    }, 3000);

    // 全屏宽视频锁定横屏（Android 有效，失败静默）
    document.addEventListener('fullscreenchange', function () {
      var fe = document.fullscreenElement;
      if (fe && TVG.Settings.orientationLock) {
        var v = fe.tagName === 'VIDEO' ? fe : fe.querySelector('video');
        if (v && v.videoWidth / (v.videoHeight || 1) > 1.3) {
          try {
            if (screen.orientation && screen.orientation.lock) {
              screen.orientation.lock('landscape').catch(function () {});
            }
          } catch (e) {}
        }
      }
    });

    // 设置实时生效（popup / 设置页改动 → storage.onChanged → 立即应用）
    if (TVG.Storage.available() && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (ch, areaName) {
        if (areaName === 'sync' && ch.cfg) {
          Object.assign(TVG.Settings, TVG.DEFAULTS, ch.cfg.newValue || {});
        }
      });
    }
  });
})();
