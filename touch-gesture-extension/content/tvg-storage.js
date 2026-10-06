// 设置读写：chrome.storage.sync，兼容无 chrome API 的特殊 frame
window.TVG = window.TVG || {};
TVG.Storage = (function () {
  'use strict';

  function available() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  return {
    available: available,
    get: function () {
      if (!available()) return Promise.resolve(Object.assign({}, TVG.DEFAULTS));
      return chrome.storage.sync.get('cfg').then(function (o) {
        return Object.assign({}, TVG.DEFAULTS, (o && o.cfg) || {});
      }).catch(function () {
        return Object.assign({}, TVG.DEFAULTS);
      });
    },
    set: function (cfg) {
      if (!available()) return Promise.resolve();
      return chrome.storage.sync.set({ cfg: cfg });
    }
  };
})();
