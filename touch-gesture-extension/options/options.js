'use strict';

// ===== 默认值（与 content/tvg-core.js 保持一致）=====
var DEFAULTS = {
  enabled: true,
  progress: true, seekMaxPercent: 50, seekCurve: 1.7, seekRealtime: false,
  volume: true, brightness: true, volGain: 1.2, brightGain: 1.2,
  fsGesture: true, fsReverse: false, fsEdgePercent: 34, fsThreshold: 40, blockDblFs: false,
  speed: true, speedStep: 0.25, instant4x: true, longPress4x: false, longPressMs: 500, longPressRate: 4,
  doubleTapSeek: true, seekStep: 10, doubleTapMs: 300,
  moveThreshold: 12,
  orientationLock: true, mouseSupport: true,
  toastY: 50, toastFont: 14, toastOpacity: 86, toastMs: 900, hintOnAttach: true,
  disabledSites: []
};

var PRESETS = {
  mild:       { seekMaxPercent: 35, seekCurve: 2.0, volGain: 1.0, brightGain: 1.0, moveThreshold: 14, toastMs: 900 },
  standard:   { seekMaxPercent: 50, seekCurve: 1.7, volGain: 1.2, brightGain: 1.2, moveThreshold: 12, toastMs: 900 },
  aggressive: { seekMaxPercent: 70, seekCurve: 1.4, volGain: 1.6, brightGain: 1.6, moveThreshold: 10, toastMs: 1200 }
};

// ===== 面板结构 =====
var SECTIONS = [
  {
    title: '通用',
    fields: [
      { key: 'enabled', type: 'bool', label: '总开关', hint: '关闭后所有手势失效' }
    ]
  },
  {
    title: '进度手势（单指左右滑）',
    fields: [
      { key: 'progress', type: 'bool', label: '启用进度手势' },
      { key: 'seekMaxPercent', type: 'range', min: 5, max: 100, step: 5, unit: '%', label: '进度强度', hint: '滑满半屏宽跳转的最大百分比' },
      { key: 'seekCurve', type: 'range', min: 1, max: 3, step: 0.05, label: '曲线指数', hint: '数值越大越平缓，小幅滑动更精准' },
      { key: 'seekRealtime', type: 'bool', label: '拖动时实时跳转', hint: '关闭（默认）＝拖动时只预览目标时间，松手才真正跳转，避免网络视频反复缓冲卡顿；开启＝拖动过程中画面实时跟随' },
      { type: 'curve' }
    ]
  },
  {
    title: '全屏切换手势（单指纵向，中间窄带）',
    fields: [
      { key: 'fsGesture', type: 'bool', label: '启用全屏切换手势', hint: '在视频中间区域纵向滑动即可进/退全屏' },
      { key: 'fsReverse', type: 'toggle', label: '手势方向', hint: '点按钮即时切换，无需保存' },
      { key: 'fsEdgePercent', type: 'range', min: 10, max: 60, step: 2, unit: '%', label: '中间窄带宽度', hint: '占视频宽度比例；左右两侧按剩余宽度均分（左亮度 / 右音量）' },
      { key: 'fsThreshold', type: 'range', min: 20, max: 120, step: 5, unit: 'px', label: '触发位移阈值', hint: '纵向滑动超过该距离才切换，防止误触' },
      { key: 'blockDblFs', type: 'bool', label: '屏蔽网页双击全屏', hint: '开启后网页双击不再进全屏，避免与「双击左/右快退快进」冲突；关闭则保留网页原生双击滑动' }
    ]
  },
  {
    title: '音量 / 亮度（仅全屏生效）',
    fields: [
      { key: 'volume', type: 'bool', label: '音量手势', hint: '右侧区域纵向滑动' },
      { key: 'volGain', type: 'range', min: 0.5, max: 3, step: 0.1, label: '音量灵敏度', hint: '滑满整屏高度的音量变化倍数' },
      { key: 'brightness', type: 'bool', label: '亮度手势', hint: '左侧区域纵向滑动' },
      { key: 'brightGain', type: 'range', min: 0.5, max: 3, step: 0.1, label: '亮度灵敏度' }
    ]
  },
  {
    title: '倍速',
    fields: [
      { key: 'speed', type: 'bool', label: '双指横向调倍速', hint: '范围 0.25x ~ 4x' },
      { key: 'speedStep', type: 'range', min: 0.25, max: 1, step: 0.25, unit: 'x', label: '倍速步长' },
      { key: 'instant4x', type: 'bool', label: '双指按下立即 4 倍速', hint: '松开恢复原速' },
      { key: 'longPress4x', type: 'bool', label: '长按进入倍速播放', hint: '按住不放触发，松开恢复；手指移动即取消（不与拖动进度冲突）' },
      { key: 'longPressMs', type: 'range', min: 200, max: 1000, step: 50, unit: 'ms', label: '长按判定时长' },
      { key: 'longPressRate', type: 'range', min: 1.5, max: 5, step: 0.5, unit: 'x', label: '长按倍速值' }
    ]
  },
  {
    title: '双击与触摸判定',
    fields: [
      { key: 'doubleTapSeek', type: 'bool', label: '双击左/右侧快退快进', hint: '双击视频左 40% / 右 40% 区域，分别快退/快进' },
      { key: 'seekStep', type: 'range', min: 5, max: 60, step: 5, unit: 's', label: '双击步长' },
      { key: 'doubleTapMs', type: 'range', min: 200, max: 500, step: 25, unit: 'ms', label: '双击判定间隔' },
      { key: 'moveThreshold', type: 'range', min: 6, max: 30, step: 2, unit: 'px', label: '起手阈值', hint: '小于该位移视为点击，不算手势' },
      { key: 'mouseSupport', type: 'bool', label: '鼠标拖拽等价手势', hint: '桌面调试用，触屏设备无影响' }
    ]
  },
  {
    title: '显示与全屏',
    fields: [
      { key: 'orientationLock', type: 'bool', label: '全屏宽视频锁定横屏' },
      { key: 'toastY', type: 'range', min: 5, max: 95, step: 5, unit: '%', label: '提示框位置', hint: '在视频高度中的百分比；放低时自动避让进度条' },
      { key: 'toastFont', type: 'range', min: 8, max: 20, step: 1, unit: 'px', label: '提示框字号' },
      { key: 'toastOpacity', type: 'range', min: 30, max: 100, step: 5, unit: '%', label: '提示框不透明度', hint: '数值越低越透明' },
      { key: 'toastMs', type: 'range', min: 500, max: 3000, step: 100, unit: 'ms', label: '提示框停留时长' },
      { key: 'hintOnAttach', type: 'bool', label: '显示"手势已启用"提示', hint: '进入含视频的页面时提示一次，用于确认引擎工作' }
    ]
  },
  {
    title: '禁用域名',
    fields: [
      { key: 'disabledSites', type: 'sites', label: '每行一个域名', hint: '例如 example.com，其子域一并禁用' }
    ]
  }
];

var cfg = Object.assign({}, DEFAULTS);
var els = {};

// 存储适配：扩展环境用 chrome.storage，普通浏览器打开时退化为 localStorage（便于预览）
var store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) ? {
  get: function () { return chrome.storage.sync.get('cfg'); },
  set: function (o) { return chrome.storage.sync.set(o); }
} : {
  get: function () {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem('tvg_cfg') || 'null'); } catch (e) {}
    return Promise.resolve({ cfg: raw || undefined });
  },
  set: function (o) {
    try { localStorage.setItem('tvg_cfg', JSON.stringify(o.cfg)); } catch (e) {}
    return Promise.resolve();
  }
};

// ===== 渲染 =====
function build() {
  var form = document.getElementById('form');
  SECTIONS.forEach(function (sec) {
    var box = document.createElement('section');
    var h = document.createElement('h2');
    h.textContent = sec.title;
    box.appendChild(h);
    sec.fields.forEach(function (f) {
      if (f.type === 'curve') { box.appendChild(buildCurve()); return; }
      box.appendChild(buildRow(f));
    });
    form.appendChild(box);
  });
}

function buildRow(f) {
  if (f.type === 'sites') {
    var wrap = document.createElement('div');
    wrap.className = 'row';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'stretch';
    var info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<span class="name">' + f.label + '</span><span class="hint">' + f.hint + '</span>';
    var ta = document.createElement('textarea');
    ta.placeholder = 'example.com\nads.example.org';
    ta.style.marginTop = '6px';
    ta.addEventListener('input', function () {
      set('disabledSites', ta.value.split(/\n+/)
        .map(function (s) { return s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); })
        .filter(Boolean));
    });
    els.disabledSites = ta;
    wrap.appendChild(info);
    wrap.appendChild(ta);
    return wrap;
  }

  var row = document.createElement('div');
  row.className = 'row';

  var info = document.createElement('div');
  info.className = 'info';
  var name = document.createElement('span');
  name.className = 'name';
  name.textContent = f.label;
  info.appendChild(name);
  if (f.hint) {
    var hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = f.hint;
    info.appendChild(hint);
  }
  row.appendChild(info);

  if (f.type === 'bool') {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', function () { set(f.key, cb.checked); });
    els[f.key] = cb;
    row.appendChild(cb);
  } else if (f.type === 'range') {
    var val = document.createElement('span');
    val.className = 'val';
    var rg = document.createElement('input');
    rg.type = 'range';
    rg.min = f.min; rg.max = f.max; rg.step = f.step;
    rg.addEventListener('input', function () { set(f.key, Number(rg.value)); });
    els[f.key] = { range: rg, val: val, unit: f.unit || '' };
    row.appendChild(rg);
    row.appendChild(val);
  } else if (f.type === 'toggle') {
    // 方向切换按钮：直接改 fsReverse，文案随状态变
    var tb = document.createElement('button');
    tb.type = 'button';
    tb.className = 'toggle-btn';
    tb.addEventListener('click', function () {
      set('fsReverse', !cfg.fsReverse);
      paintToggle(tb);
    });
    els[f.key] = tb;
    paintToggle(tb);
    row.appendChild(tb);
  } else if (f.type === 'select') {
    var sel = document.createElement('select');
    f.options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { set(f.key, sel.value); });
    els[f.key] = sel;
    row.appendChild(sel);
  }
  return row;
}

// ===== 进度曲线预览 =====
function buildCurve() {
  var wrap = document.createElement('div');
  wrap.className = 'row curve-wrap';
  wrap.style.flexDirection = 'column';
  wrap.style.alignItems = 'stretch';
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 180');
  svg.innerHTML =
    '<line x1="40" y1="150" x2="385" y2="150" stroke="#3a3d46" stroke-width="1"/>' +
    '<line x1="40" y1="20" x2="40" y2="150" stroke="#3a3d46" stroke-width="1"/>' +
    '<text x="42" y="168" fill="#7f8794" font-size="11">0</text>' +
    '<text x="200" y="168" fill="#7f8794" font-size="11" text-anchor="middle">滑动 1/4 屏宽</text>' +
    '<text x="385" y="168" fill="#7f8794" font-size="11" text-anchor="end">滑满半屏宽</text>' +
    '<text x="34" y="24" fill="#7f8794" font-size="11" text-anchor="end">100%</text>' +
    '<text x="34" y="152" fill="#7f8794" font-size="11" text-anchor="end">0%</text>' +
    '<path id="curvePath" d="" fill="none" stroke="#378add" stroke-width="2"/>' +
    '<path id="curveLine" d="" fill="none" stroke="#6fbf7a" stroke-width="1" stroke-dasharray="4 4"/>';
  wrap.appendChild(svg);
  var cap = document.createElement('span');
  cap.className = 'hint';
  cap.id = 'curveCap';
  wrap.appendChild(cap);
  return wrap;
}

function updateCurve() {
  var path = document.getElementById('curvePath');
  if (!path) return;
  var maxP = cfg.seekMaxPercent, curve = cfg.seekCurve;
  var pts = [];
  for (var i = 0; i <= 40; i++) {
    var x = i / 40;                       // 0~1：滑动距离 / 半屏宽
    var y = Math.pow(x, curve) * maxP;    // 跳转百分比
    var px = 40 + x * 345;
    var py = 150 - (y / 100) * 130;
    pts.push(px.toFixed(1) + ',' + py.toFixed(1));
  }
  path.setAttribute('d', 'M' + pts.join(' L'));

  var q = Math.pow(0.25, curve) * maxP;
  var h = Math.pow(0.5, curve) * maxP;
  var line = document.getElementById('curveLine');
  if (line) {
    var qx = 40 + 0.25 * 345;
    var qy = 150 - (q / 100) * 130;
    line.setAttribute('d', 'M' + qx + ',150 L' + qx + ',' + qy.toFixed(1));
  }
  var cap = document.getElementById('curveCap');
  if (cap) {
    cap.textContent = '当前手感：滑 1/4 屏宽 ≈ 总时长 ' + q.toFixed(1) + '%　|　滑满半屏 ≈ ' + h.toFixed(1) + '%';
  }
}

// 切换按钮文案：明确当前方向语义
function paintToggle(btn) {
  if (!btn) return;
  btn.textContent = cfg.fsReverse ? '↑ 上滑退出 / 下滑全屏' : '↓ 下滑全屏 / 上滑退出';
  btn.classList.toggle('rev', !!cfg.fsReverse);
}

// ===== 状态同步 =====
function refresh() {
  Object.keys(els).forEach(function (k) {
    var e = els[k];
    if (k === 'disabledSites') { e.value = (cfg.disabledSites || []).join('\n'); return; }
    if (k === 'fsReverse') { paintToggle(e); return; }
    if (e.range) {
      e.range.value = cfg[k];
      e.val.textContent = cfg[k] + e.unit;
      return;
    }
    if (e.type === 'checkbox') e.checked = !!cfg[k];
    else e.value = cfg[k];
  });
  updateCurve();
}

var saveTimer = null;

function set(key, value) {
  cfg[key] = value;
  if (els[key] && els[key].range) els[key].val.textContent = value + els[key].unit;
  if (key === 'seekMaxPercent' || key === 'seekCurve') updateCurve();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    store.set({ cfg: cfg }).then(flashTip);
  }, 120);
}

function flashTip() {
  var tip = document.getElementById('tip');
  tip.classList.add('show');
  clearTimeout(tip._t);
  tip._t = setTimeout(function () { tip.classList.remove('show'); }, 1200);
}

// ===== 预设与导出 =====
document.querySelectorAll('[data-preset]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var name = btn.dataset.preset;
    if (name === 'reset') cfg = Object.assign({}, DEFAULTS);
    else cfg = Object.assign({}, cfg, PRESETS[name]);
    store.set({ cfg: cfg }).then(function () {
      refresh();
      flashTip();
    });
  });
});

var copyBtn = document.getElementById('copyConfig');
if (copyBtn) {
  copyBtn.addEventListener('click', function () {
    var text = JSON.stringify(cfg, null, 2);
    navigator.clipboard.writeText(text).then(function () {
      var tip = document.getElementById('tip');
      tip.textContent = '配置已复制到剪贴板';
      flashTip();
      setTimeout(function () { tip.textContent = '已保存'; }, 1800);
    });
  });
}

// popup 里的"打开完整设置页"
var openBtn = document.getElementById('openOptions');
if (openBtn) {
  openBtn.addEventListener('click', function () {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      window.close();
    }
  });
}

// 诊断 + 一键禁用当前网站（popup 用）
var diag = document.getElementById('diagNote');
var siteBtn = document.getElementById('toggleSite');
var currentHost = null;

function version() {
  try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
}

function refreshSiteBtn() {
  if (!siteBtn) return;
  if (!currentHost) {
    siteBtn.disabled = true;
    siteBtn.textContent = '当前网站不可用';
    return;
  }
  var off = (cfg.disabledSites || []).indexOf(currentHost) >= 0;
  siteBtn.disabled = false;
  siteBtn.textContent = off ? '已禁用本网站 · 点此恢复' : '在本网站禁用手势';
}

function toggleSite() {
  if (!currentHost) return;
  var list = (cfg.disabledSites || []).slice();
  var i = list.indexOf(currentHost);
  if (i >= 0) list.splice(i, 1);
  else list.push(currentHost);
  cfg.disabledSites = list;
  store.set({ cfg: cfg }).then(function () {
    refreshSiteBtn();
    var tip = document.getElementById('tip');
    if (tip) {
      tip.textContent = i >= 0 ? '已恢复，刷新页面生效' : '已禁用，刷新页面生效';
      flashTip();
      setTimeout(function () { tip.textContent = '已保存'; }, 1800);
    }
  });
}

if (siteBtn) siteBtn.addEventListener('click', toggleSite);

if (diag && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) { refreshSiteBtn(); return; }
    // 从 URL 里取域名（activeTab 权限）
    try {
      if (tab.url && /^https?:/.test(tab.url)) currentHost = new URL(tab.url).hostname;
    } catch (e) {}

    function statFrame(frameId, cb) {
      chrome.tabs.sendMessage(tab.id, { type: 'tvg:stats' }, { frameId: frameId }, function (res) {
        var err = !!chrome.runtime.lastError;
        cb(err ? null : res);
      });
    }

    function shortHost(url) {
      try {
        var u = new URL(url);
        if (u.protocol === 'blob:') return 'blob页面';
        if (u.protocol === 'about:') return 'about空白帧';
        if (u.protocol === 'data:') return 'data帧';
        return u.hostname.replace(/^www\./, '');
      } catch (e) {
        return String(url).slice(0, 24);
      }
    }

    function render(results, frames) {
      var taken = 0, raw = 0, deep = 0, anyRes = false, host = null;
      results.forEach(function (r) {
        if (!r) return;
        anyRes = true;
        taken += r.videos || 0;
        raw += r.rawVideos || 0;
        deep += r.deepVideos || 0;
        if (r.host) host = r.host;
      });
      if (host) currentHost = host;
      refreshSiteBtn();

      if (taken > 0) {
        diag.textContent = '已接管 ' + taken + ' 个视频（共 ' + frames.length + ' 帧）· v' + version();
        return;
      }
      if (!anyRes) {
        diag.textContent = '无手势运行（扩展未注入本页）· v' + version();
        return;
      }
      // 逐帧点名（全部帧，不截断）：URL 从浏览器层面获取，未注入/未响应也会列出
      var parts = [];
      frames.forEach(function (f, i) {
        var h = shortHost(f.url);
        var r = results[i];
        var label;
        if (!r) {
          label = h + '(未注入)';
        } else if (r.videos > 0) {
          label = h + '(已接管' + r.videos + ')';
        } else {
          var n = Math.max(r.rawVideos || 0, r.deepVideos || 0);
          if (n > 0) {
            var note = (r.rawVideos === 0 && r.deepVideos > 0) ? '·shadow内' : '';
            var extra = r.reject ? '·' + r.reject : (r.unreg ? '·' + r.unreg : '');
            label = h + '(' + n + '个未接管' + note + '·试' + (r.attempts || 0) + '次' + extra + ')';
          } else {
            label = h + '(无video' + (r.iframes ? '/' + r.iframes + 'iframe' : '') + ')';
          }
        }
        parts.push(label);
      });
      diag.textContent = '未接管（共 ' + frames.length + ' 帧）:\n' + parts.join('\n') + '\nv' + version();
    }

    // 跨帧诊断：遍历所有 frame 收集统计（iframe 播放器场景关键）
    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      chrome.webNavigation.getAllFrames({ tabId: tab.id }, function (frames) {
        if (!frames || !frames.length) { singleFrame(); return; }
        var pending = frames.length;
        var results = [];
        frames.forEach(function (f, idx) {
          statFrame(f.frameId, function (res) {
            results[idx] = res;
            if (--pending === 0) render(results, frames);
          });
        });
      });
    } else {
      singleFrame();
    }

    function singleFrame() {
      statFrame(0, function (res) {
        render([res], [{ frameId: 0, url: (tab && tab.url) || '未知' }]);
      });
    }
  });
}

// ===== 启动 =====
build();
store.get('cfg').then(function (o) {
  cfg = Object.assign({}, DEFAULTS, (o && o.cfg) || {});
  refresh();
  refreshSiteBtn();
});
