# Touch Video Gestures: Touch Gestures for Video

**English** | [简体中文](README.md)

A browser extension (Manifest V3) that adds touchscreen gesture controls to video players on any website.

On a phone, tablet, or emulator, the browser's native video control bar is tiny and hard to hit. This extension adds large, easy-to-reach gestures on top of the video — without breaking the page's own scrolling.

## Features

| Gesture | Action |
|---|---|
| Horizontal swipe | Seek through the video (percentage of total duration, non-linear curve) |
| Double-tap left / right area | Rewind / fast-forward (step adjustable, 10s by default) |
| Vertical swipe in the center area | Toggle fullscreen (swipe down to enter, up to exit by default; direction reversible) |
| Vertical swipe while fullscreen | Left side adjusts brightness / right side adjusts volume |
| Long press | Play at increased speed (4x by default, restores on release) |
| Two-finger horizontal swipe | Fine-tune playback speed (0.25x – 4x) |

- **Universal**: not tied to any specific site. Tuned for common video sites and iframe-embedded players, including canvas-rendered players.
- **Non-intrusive**: when not fullscreen, swipes outside the video area are left to the page's normal scrolling.
- **Multiple videos per page**: hit-testing is geometric — you control the video your finger actually landed on.
- **Fully configurable**: every gesture's on/off switch, sensitivity, threshold, and toast styling can be changed in the options panel.

## Install

### From the stores

- Microsoft Edge Add-ons: *(link to be added after publishing)*
- Chrome Web Store: *(link to be added after publishing)*

### From Releases

**Android / Edge Canary → use the `.crx`**

1. Go to [Releases](https://github.com/Ywocp/Touch-Video-Gestures/releases) and download the latest `touch-gesture-extension-v*.crx`
2. Open the downloaded file in your browser and confirm the installation

> Works on browsers that allow direct `.crx` installation, such as **Microsoft Edge Canary for Android**.
> **Desktop Chrome / Edge block non-store `.crx` files** — desktop users should use the `.zip` below.

**Desktop → use the `.zip`**

1. Download the latest `touch-gesture-extension-v*.zip`
2. Unzip it to any directory
3. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**
4. Click **Load unpacked** and select the unzipped directory

### From source

1. Open `edge://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `touch-gesture-extension/` directory in this repository

## Project structure

```
touch-gesture-extension/     The extension itself (load this directory)
├── manifest.json            MV3 manifest
├── content/                 Content scripts
│   ├── tvg-core.js          Default config and shared utilities
│   ├── tvg-storage.js       Storage layer (chrome.storage.sync, localStorage fallback)
│   ├── tvg-ui.js            Toast notifications
│   ├── tvg-locator.js       Video discovery and geometric hit-testing
│   ├── tvg-gesture.js       Gesture engine (core)
│   └── tvg-main.js          Entry point and lifecycle
├── popup/                   Toolbar popup (diagnostics, per-domain disable)
├── options/                 Full options panel
└── icons/                   Icons (16/20/24/32/48/128)

PRIVACY_POLICY.md            Privacy policy
LICENSE                      MIT License
```

## Technical notes

- **Listeners are attached in the `document` capture phase**, so site scripts can't intercept them.
- **Video routing uses geometric hit-testing** (which video rectangle the touch point falls inside) rather than DOM lookups.
- **Fullscreen detection inside iframes**: `fullscreenElement` is null within an iframe, so it falls back to a "viewport ≈ screen size" check.
- **Canvas-rendered players**: when `<video>` is hidden at zero size, the container rectangle is used for registration and hit-testing instead.
- **Starting a swipe in the center band while not fullscreen** requires a temporary `touch-action: none` class to lock out `pan-y`, otherwise the browser steals the gesture frames.

## Privacy

This extension **collects no data, makes no network requests, and contains no remote code**. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## License

Open source under the [MIT License](LICENSE).
