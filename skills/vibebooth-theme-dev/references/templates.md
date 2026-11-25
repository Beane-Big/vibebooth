# Vibebooth 主题最小模板参考

## 1. `theme.yaml`
```yaml
platform: 1
id: soft-mist
name: 柔雾清晨
description: 柔和浅蓝渐变与通透毛玻璃质感
version: 0.1.0
script: theme.js
style: theme.css
preview: preview.svg
```

## 2. `theme.js`（IIFE，零构建直接可用）
```js
(function () {
  var vb = window.vibebooth;
  if (!vb || typeof vb.registerTheme !== "function") return;

  vb.registerTheme({
    background: {
      light: "linear-gradient(135deg, #eef4ff 0%, #f8f0ff 55%, #eefaf6 100%)",
      dark: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 55%, #0f292f 100%)",
    },
    glass: { blur: 22, opacity: 0.68 },
    antd: {
      light: {
        token: { colorPrimary: "#4c6ef5", borderRadius: 14 },
      },
      dark: {
        token: { colorPrimary: "#748ffc", borderRadius: 14 },
      },
    },
    icons: {
      light: { bg: "linear-gradient(145deg, #eef2ff, #dbe4ff)", fg: "#4263eb" },
      dark: { bg: "rgba(255, 255, 255, 0.12)", fg: "#bac8ff" },
    },
    wordmark: {
      light: ["#4263eb", "#7950f2", "#e64980"],
      dark: ["#91a7ff", "#b197fc", "#faa2c1"],
    },
  });
})();
```

## 3. `theme.css`
```css
.theme-soft-mist .topbar {
  border-bottom: 1px solid rgba(76, 110, 245, 0.12);
}

.theme-soft-mist .app-icon {
  border-radius: 18px;
}
```

## 4. `preview.svg`（1280x800 预览示意图）
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef4ff"/>
      <stop offset="55%" stop-color="#f8f0ff"/>
      <stop offset="100%" stop-color="#eefaf6"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="800" fill="url(#bg)"/>
  <rect x="48" y="32" width="1184" height="64" rx="20" fill="#ffffff" fill-opacity="0.72"/>
  <rect x="80" y="52" width="140" height="24" rx="8" fill="#4c6ef5"/>
  <rect x="80" y="140" width="352" height="180" rx="20" fill="#ffffff" fill-opacity="0.74"/>
  <rect x="464" y="140" width="352" height="180" rx="20" fill="#ffffff" fill-opacity="0.74"/>
  <rect x="848" y="140" width="352" height="180" rx="20" fill="#ffffff" fill-opacity="0.74"/>
</svg>
```
