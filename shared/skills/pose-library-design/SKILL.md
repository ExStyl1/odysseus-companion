---
name: "pose-library-design"
description: "Проектирование библиотеки поз, эмоций и циклов действий для повторного использования в 2D-анимации."
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


# Pose Library Design

Use this skill when producing `pose_library` artifacts.

## Pose Categories

- Neutral: idle, breathe, listening.
- Attention: look_up, look_down, look_left, look_right.
- Emotion: happy, sad, surprised, worried, determined.
- Action: reach, point, hold, jump, flap, walk_contact, walk_passing.
- Mouth: closed, small_o, wide_open, smile, frown, phoneme-ish shapes.

## Acting Pattern

Use timed pose sequences:

```text
anticipation -> action -> hold -> settle
```

Do not continuously animate every part. Holds make the acting readable.

## Pose Data Pattern

```json
{
  "pose": "surprised",
  "parts": {
    "head": { "rotation": -6, "y": -4 },
    "pupil_left": { "x": 4, "y": -6 },
    "mouth": "small_o"
  },
  "hold_frames": 18,
  "transition": "back.out"
}
```

## Quality Checklist

- Required emotions have poses.
- Required actions have poses or cycles.
- Reused cycles have contact and passing poses.
- Poses name only changed parts; defaults come from the rig.

## Sources

- GSAP timeline sequencing for readable multi-step poses:
  https://gsap.com/docs/v3/GSAP/Timeline/
- Remotion interpolation for frame-based transitions:
  https://www.remotion.dev/docs/interpolate
- Remotion spring for natural motion:
  https://www.remotion.dev/docs/spring
