# Touch Video Gestures：触控视频手势

[English](README.en.md) | **简体中文**

为任意网站的视频播放器提供触摸屏手势控制的浏览器扩展（Manifest V3）。

在手机、平板或模拟器上用触摸屏看视频时，浏览器原生的播放器控制条又小又难点。
本扩展为视频加上大范围、易触达的手势操作，并且不影响页面本身的滚动。

## 功能

| 手势 | 作用 |
|---|---|
| 横向滑动 | 调节播放进度（按总时长百分比，非线性曲线） |
| 双击左 / 右区域 | 快退 / 快进（步长可调，默认 10 秒） |
| 中间区域纵向滑动 | 切换全屏（默认下滑进入、上滑退出，方向可反转） |
| 全屏时纵向滑动 | 左侧调亮度 / 右侧调音量 |
| 长按 | 倍速播放（默认 4x，松手恢复） |
| 双指横向滑动 | 精细调节倍速（0.25x ~ 4x） |

- **通用适配**：不绑定任何特定站点。已针对常见视频站与 iframe 内嵌播放器（含 canvas 渲染型播放器）做过适配。
- **不干扰浏览**：非全屏状态下，视频区域外的滑动仍交给页面正常滚动。
- **同页多视频**：按触点几何位置命中，操作的是你手指点到的那一个。
- **全部可调**：每个手势的开关、灵敏度、阈值、提示框样式都能在设置面板里改。

## 安装

### 商店安装

- Microsoft Edge 加载项：*（上架后补充链接）*
- Chrome 网上应用店：*（上架后补充链接）*

### 从 Releases 下载安装

1. 前往 [Releases](https://github.com/Ywocp/Touch-Video-Gestures/releases) 下载最新的 `touch-gesture-extension-v*.zip`
2. 解压到任意目录
3. 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」
4. 点击「加载解压缩的扩展」，选择解压出的目录

### 从源码加载

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 开启「开发人员模式」
3. 点击「加载解压缩的扩展」，选择本仓库的 `touch-gesture-extension/` 目录

## 目录结构

```
touch-gesture-extension/     扩展本体（加载这个目录）
├── manifest.json            MV3 清单
├── content/                 内容脚本
│   ├── tvg-core.js          配置默认值与共享工具
│   ├── tvg-storage.js       存储层（chrome.storage.sync + localStorage 降级）
│   ├── tvg-ui.js            提示框（Toast）
│   ├── tvg-locator.js       视频发现与几何命中
│   ├── tvg-gesture.js       手势引擎（核心）
│   └── tvg-main.js          入口与生命周期
├── popup/                   工具栏弹窗（诊断与一键禁用域名）
├── options/                 完整设置面板
└── icons/                   图标（16/20/24/32/48/128）

PRIVACY_POLICY.md            隐私政策
LICENSE                      MIT 许可证
```

## 技术要点

- **事件监听在 `document` 捕获阶段**，抗站点脚本拦截
- **视频路由用几何命中**（触点落在哪个 video 矩形内），而非 DOM 查找
- **iframe 内全屏判定**：iframe 内 `fullscreenElement` 为 null，用「视口 ≈ 屏幕尺寸」回退判定
- **canvas 渲染型播放器**：`<video>` 被隐藏为 0 尺寸，用容器矩形做注册与命中回退
- **非全屏中间带起手**：用临时 `touch-action: none` 类锁住 `pan-y`，防止浏览器抢走手势帧

## 隐私

本扩展**不收集任何数据、不联网、无远程代码**。详见 [PRIVACY_POLICY.md](PRIVACY_POLICY.md)。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
