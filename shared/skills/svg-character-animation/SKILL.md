---
name: "svg-character-animation"
description: "Анимация SVG-персонажей через GSAP, CSS или покадровое управление Remotion."
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


# SVG Character Animation

Use this skill when animating character rigs made from SVG parts.

## Runtime Rules

- Animate transforms (`x`, `y`, `scale`, `rotation`) rather than layout.
- Use timelines for multi-part acting beats.
- For SVG elements, use stable pivots (`svgOrigin` or correctly scoped
  transform origins).
- In Remotion, do not let GSAP advance with `requestAnimationFrame`; drive a
  paused timeline from the current frame.

## Browser Pattern

```js
gsap.set("#arm_right", { svgOrigin: "390 310" });
const tl = gsap.timeline({ defaults: { ease: "power2.inOut" } });
tl.to("#head", { rotation: -8, duration: 0.2 })
  .to("#arm_right", { rotation: 35, duration: 0.4 }, "<");
```

## Remotion Pattern

```tsx
const frame = useCurrentFrame();
const progress = frame / durationInFrames;
timeline.progress(progress);
```

## HyperFrames Pattern

Use HTML/SVG/GSAP components with deterministic timelines and validate via the
HyperFrames CLI before final render.

## Quality Checklist

- Parts stay connected at pivots during motion.
- Blinks, gaze, and mouth shapes are separate enough to read.
- Pose holds are long enough to communicate emotion.
- Frame sampling shows meaningful deltas, not frozen animation.

## Sources

- GSAP core transform properties and SVG handling:
  https://gsap.com/docs/v3/GSAP/CorePlugins/CSS/
- GSAP timelines and sequencing:
  https://gsap.com/docs/v3/GSAP/Timeline/
- Remotion `useCurrentFrame`:
  https://www.remotion.dev/docs/use-current-frame
