---
name: html-prototype-builder
description: Build functional single-file HTML prototypes for mobile-first Chinese consumer apps. Use when user asks for a prototype, mockup, demo page, HTML wireframe, interactive preview, or wants to visualize an app concept as working code.
station: global
kind: instruction
version: 1
---

# HTML Prototype Builder

## Purpose

Produce working single-file HTML that looks like a real mobile app screen, can be opened directly in a browser, and demonstrates the core user flow — not a wireframe, not a lorem ipsum layout. The prototype should be good enough to share with a WeChat group and get real feedback.

## Output Constraints

**Always single file**: All CSS and JS inline or in `<style>`/`<script>` tags. No external dependencies except CDN-loaded fonts.

**Mobile-first**: Default viewport width 390px (iPhone 14). Use `<meta name="viewport" content="width=device-width, initial-scale=1">`.

**No build step**: Pure HTML + CSS + vanilla JS only. No React, Vue, or bundlers.

**Chinese content**: Use actual Chinese copy, not placeholder text. Real product copy makes feedback 10x more useful.

## Structure Template

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[产品名]</title>
<style>
  /* Reset + base */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'PingFang SC', sans-serif; background: #[bg]; max-width: 390px; margin: 0 auto; min-height: 100vh; }
  
  /* App chrome */
  .status-bar { height: 44px; /* iPhone status bar placeholder */ }
  .nav-bar { ... }
  .tab-bar { position: fixed; bottom: 0; width: 100%; max-width: 390px; ... }
  
  /* Content */
  .page { padding: 0 0 80px; /* tab bar clearance */ }
</style>
</head>
<body>
  <!-- Content -->
  <script>
    // Minimal interactivity
  </script>
</body>
</html>
```

## Design Token Choices by Product Type

**女性消费品 (female consumer):**
```css
--bg: #FDF8F4;
--surface: #FFFFFF;
--primary: #D4A0C0;      /* dusty rose */
--text: #2D2D2D;
--muted: #9B8EA0;
--border: #EDE8EC;
--radius: 16px;
```

**玄学/命理 (fortune/metaphysics):**
```css
--bg: #0D0A18;           /* deep night */
--surface: #1A1528;
--primary: #C9A6FF;      /* soft purple */
--accent: #F0C060;       /* gold */
--text: #E8E0F0;
--muted: #7A6E8A;
--border: rgba(201,166,255,0.2);
--radius: 12px;
```

**工具/生产力 (productivity):**
```css
--bg: #F5F7FA;
--surface: #FFFFFF;
--primary: #4A90E2;
--text: #1A1A2E;
--muted: #6B7280;
--border: #E5E7EB;
--radius: 10px;
```

## Component Patterns

**Identity/result card (可分享卡片):**
```html
<div class="result-card" style="background: linear-gradient(135deg, #1A0533, #2D1B69); border-radius: 20px; padding: 28px 24px; color: white; position: relative; overflow: hidden;">
  <div class="card-deco"><!-- SVG decorative element --></div>
  <div class="card-label" style="font-size: 11px; opacity: 0.6; letter-spacing: 2px;">你的命格</div>
  <div class="card-title" style="font-size: 36px; font-weight: 700; margin: 8px 0;">紫微天相</div>
  <div class="card-sub" style="font-size: 13px; opacity: 0.8; line-height: 1.6;">...</div>
  <div class="card-footer"><!-- branding --></div>
</div>
```

**Quiz question step:**
```html
<div class="question-step" data-step="1">
  <div class="progress-bar"><div class="progress-fill" style="width: 33%"></div></div>
  <h2 class="question-text">你最近最常有的感觉是？</h2>
  <div class="options">
    <button class="option" onclick="selectOption(this, 'a')">迷茫，不知道下一步去哪</button>
    <button class="option" onclick="selectOption(this, 'b')">还不错，但想要更多</button>
  </div>
</div>
```

**Bottom CTA bar:**
```html
<div class="cta-bar" style="position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 390px; padding: 12px 20px 32px; background: linear-gradient(to top, var(--bg) 70%, transparent); z-index: 10;">
  <button class="cta-btn" style="width: 100%; padding: 16px; border-radius: 50px; background: var(--primary); color: white; font-size: 17px; font-weight: 600; border: none;">查看我的完整命格 →</button>
</div>
```

## Interactivity Guidelines

Keep JS minimal and readable:
- Tab switching: toggle `.active` class
- Quiz flow: show/hide `.question-step[data-step]` divs
- Reveal animation: use CSS `@keyframes` + JS to add `.visible` class
- Share card save: use `html2canvas` from CDN only if explicitly needed

## Quality Bar

Before outputting the prototype:
- [ ] Can be opened by double-clicking the .html file with no server
- [ ] Looks like a real app, not a wireframe
- [ ] Has real Chinese copy in every visible text element
- [ ] Has at least one interactive element (tap/click does something)
- [ ] Has a primary CTA that is visually prominent
- [ ] No horizontal scroll on 390px viewport
