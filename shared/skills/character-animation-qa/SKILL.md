---
name: "character-animation-qa"
description: "Проверка анимации персонажа: схема, кадры, браузерный предпросмотр и итоговое видео."
license: "MIT"
disable-model-invocation: false
user-invocable: true
when_to_use: "При подготовке соответствующей анимации или видео; вход — бриф, длительность, размер кадра и доступные локальные ресурсы."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus execution profile: local, browser and Obsidian

This installation is configured for local execution. This profile narrows the
upstream workflows below and takes precedence over their optional online modes.
Use the current Nessy agent/model, local files, installed CLI tools and libraries.
Browser interaction and the local Obsidian integration are explicitly allowed.

- Do not request, configure or use extra API keys, cloud AI providers, hosted
  rendering, SaaS MCP connections or another agent runtime to complete this skill.
- Use local inputs, cached/bundled assets and installed local engines. When web
  content is necessary, use the host's browser tools; do not replace them with a
  provider API, authenticated scraping service or non-browser cloud connector.
- Select documented offline branches without waiting for cloud sign-in. Ignore
  upstream instructions to refresh skills remotely, log into a provider, generate
  media remotely, publish through a SaaS API, or invoke a removed skill.
- Use native host tools for browser control, subagents and language servers when
  available. A local LSP/MCP adapter is allowed; a foreign agent/plugin runtime is
  not a prerequisite to install. Report missing local capability honestly.
- If the requested output cannot be produced locally, explain the missing local
  input or tool. Do not silently switch to a cloud service or claim completion.
  Installing a skill does not install its local engines or dependencies.

For media workflows use installed local HyperFrames/Remotion/FFmpeg/Manim,
local audio/video and supplied assets. Use offline TTS/transcription only when
installed. Skip cloud media resolve, remote asset generation and hosted rendering;
keep local asset lookup, editing, preview, analysis and rendering.

---


# Character Animation QA

Use this skill before presenting a character-animation preview or final render.

## Review Layers

1. Schema validation: character design, rig plan, pose library, action timeline.
2. Static asset checks: referenced parts and backgrounds exist.
3. Browser preview: load the preview, capture screenshots, collect console errors.
4. Motion check: compare sampled frames for non-trivial differences.
5. Final MP4 check: ffprobe metadata, duration, resolution, audio, frame samples.
6. Agent visual review: inspect sampled frames for detached limbs, bad layers,
   off-frame characters, unreadable expressions, broken text.

## Playwright Pattern

```ts
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(previewUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: "preview.png" });
```

## Pass/Revise/Fail

- `pass`: technical checks pass, acting is readable.
- `revise`: fixable rig/timeline issue.
- `fail`: missing assets, blank render, runtime failure, or wrong runtime.

## Sources

- Playwright screenshots:
  https://playwright.dev/docs/screenshots
- Playwright page navigation:
  https://playwright.dev/docs/api/class-page#page-goto
- FFmpeg/ffprobe should be used for final media probing:
  https://ffmpeg.org/ffprobe.html
