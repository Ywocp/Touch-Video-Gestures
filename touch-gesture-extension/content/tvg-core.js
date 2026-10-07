// TVG = Touch Video Gestures 命名空间 + 默认配置 + 共享工具
// 模块结构（v1.1.0 重构，加载顺序：core → storage → ui → locator → zone → bridge → session → main）：
//   · Zone    区域/注册中心：视频注册表、容器 touch-action、中央全屏带（预置抓取层）
//   · Bridge  站点桥：与站点打交道的一切（全屏按钮、点击转发、事件切断/合成取消）
//   · Session 手势状态机：观察 → 仲裁 → 执行（window 捕获统一接收）
window.TVG = (function () {
  'use strict';

  var DEFAULTS = {
    // 总开关
    enabled: true,

    // 进度（单指左右滑）
    progress: true,
    seekMaxPercent: 25,   // 滑满半屏宽跳转的最大百分比
    seekCurve: 3,         // 非线性曲线指数，越大越平缓（小滑动更精准）
    seekRealtime: false,  // 拖动时实时跳转？false=只预览、松手才加载（网络视频更顺）

    // 音量 / 亮度（仅全屏）
    volume: true,
    brightness: true,
    volGain: 1.2,         // 灵敏度：滑满整屏高度对应的音量变化倍数
    brightGain: 1.2,

    // 全屏切换手势（单指纵向滑动，中间窄带）
    // 方向语义参照 PiliPlus：默认下滑进全屏、上滑退出；fsReverse 可反转
    fsGesture: false,     // 总开关（默认关闭：纵向滑动优先留给页面滚动；需要时在设置中开启）
    fsReverse: false,     // false=下滑进全屏/上滑退出；true=反过来
    fsEdgePercent: 20,    // 中间全屏窄带宽度（占视频宽度 %），左右两侧均分剩余
    fsThreshold: 40,      // 触发全屏切换所需的最小纵向位移（px）
    blockDblFs: false,    // 屏蔽站点/浏览器自带的双击全屏（避免与双击快进冲突）

    // 倍速
    speed: true,          // 双指横向
    speedStep: 0.25,
    instant4x: true,      // 双指按下立即 4 倍速，松开恢复
    longPress4x: true,    // 长按进入倍速播放，松开恢复（倍速值见 longPressRate）
    longPressMs: 500,
    longPressRate: 2,     // 长按倍速值（1.5x ~ 5x）

    // 双击快进快退
    doubleTapSeek: true,
    seekStep: 10,
    doubleTapMs: 300,

    // 触摸判定阈值
    moveThreshold: 12,    // 起手多大位移才算手势（px）

    // 行为
    orientationLock: true,
    mouseSupport: true,   // 鼠标拖拽等价触摸（桌面调试用）
    toastY: 10,           // 提示框在视频高度中的纵向位置（%），偏下时自动避让进度条
    toastFont: 8,         // 提示框基准字号（px，随视频大小自适应缩放）
    toastOpacity: 70,     // 提示框不透明度（%，越低越透明）
    toastMs: 900,
    hintOnAttach: true,   // 页面首次接管视频时提示"手势已启用"

    // 禁用域名
    disabledSites: []
  };

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }

  // 时间格式化（多处复用：进度/提示）
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

  // 当前生效配置（storage 就绪前回退默认值）
  function cfg() { return TVG.Settings || DEFAULTS; }

  // 激活状态：与「监听器注册」解耦——监听器在 document_start 就绪（事件隔离的
  // 注册顺序前提），但禁用域名 / 总开关关闭时不产生任何行为。
  // Session.setActive 负责写入 + 副作用（复位手势、同步预置带）。
  var act = { live: true };
  function isActive() { return act.live && !!cfg().enabled; }

  return {
    DEFAULTS: DEFAULTS,
    clamp: clamp,
    fmt: fmt,
    cfg: cfg,
    act: act,
    isActive: isActive
  };
})();
