---
name: "canvas-procedural-animation"
description: "Создание процедурной 2D-анимации на p5.js и Canvas: частицы, погода и циклы движения."
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


# Canvas Procedural Animation

Use this skill when p5.js or Canvas is used for character-supporting motion:
rain, snow, leaves, feathers, ambient particles, squash/stretch, or procedural
walk cycles.

## Proven Pattern

p5.js runs setup once and redraws continuously through `draw()`. Keep animation
state deterministic from time/frame values when rendering previews.

```js
function setup() {
  createCanvas(1920, 1080);
}

function draw() {
  const t = millis() / 1000;
  clear();
  drawCharacter(width / 2, height / 2 + sin(t * 8) * 8);
}
```

## Use For

- Particle/weather overlays.
- Environmental motion.
- Simple procedural bodies.
- Effects that do not need individually authored SVG parts.

## Avoid For

- Complex facial acting where SVG/layered rig parts are easier to inspect.
- Final renders that need exact frame determinism unless the runtime exposes
  frame-index control.

## Sources

- p5.js `setup()` reference: https://p5js.org/reference/p5/setup/
- p5.js `draw()` reference: https://p5js.org/reference/p5/draw/
- p5.js animation examples: https://p5js.org/examples/
