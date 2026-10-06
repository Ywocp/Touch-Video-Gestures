// TVG = Touch Video Gestures 命名空间 + 默认配置 + 工具函数
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
    fsGesture: true,      // 总开关
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
    toastFont: 8,         // 提示框字号（px）
    toastOpacity: 70,     // 提示框不透明度（%，越低越透明）
    toastMs: 900,
    hintOnAttach: true,   // 页面首次接管视频时提示"手势已启用"

    // 禁用域名
    disabledSites: []
  };

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }

  return { DEFAULTS: DEFAULTS, clamp: clamp };
})();
