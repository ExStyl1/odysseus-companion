---
name: "character-rigging"
description: "Создание управляемого 2D-рига персонажа: части, опорные точки, слои и ограничения."
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


# Character Rigging

Use this skill when building OpenMontage `rig_plan` artifacts or renderer input
for local 2D character animation.

## Proven Patterns

- Keep runtime code generic; make each character a data package.
- Split characters into independently transformable parts.
- Define pivots in the same coordinate space as the artwork.
- Store constraints on moving parts to prevent impossible rotations.
- Keep layer order explicit; do not rely on SVG source order after generation.
- Start with one view and add views only when the shot list requires them.

## Rig Package

```json
{
  "character_id": "mouse",
  "rig_type": "svg_rig",
  "parts": [
    { "id": "body", "kind": "torso", "layer": 10 },
    { "id": "head", "kind": "head", "layer": 30, "parent": "body" },
    { "id": "arm_right", "kind": "limb", "layer": 40, "parent": "body" }
  ],
  "joints": {
    "head": { "pivot": [320, 180], "rotation": [-20, 20] },
    "arm_right": { "pivot": [390, 310], "rotation": [-70, 95] }
  }
}
```

## Quality Checklist

- Every moving part has a pivot.
- Every child part has a parent where hierarchy matters.
- Mouth shapes are separate assets or separate path groups.
- Eyes and pupils are separate when gaze needs to change.
- Props are separate if the character touches or carries them.

## Sources

- SVG transform-origin behavior is browser-defined and can be sensitive to
  coordinate space; prefer explicit SVG-coordinate pivots when using GSAP
  `svgOrigin`: https://gsap.com/docs/v3/GSAP/CorePlugins/CSS/
- Remotion animations must be frame-driven and deterministic via current frame:
  https://www.remotion.dev/docs/use-current-frame
