---
name: "seam-craft"
description: "Проверка стыков сцен HyperFrames: композитинг, слои и отсутствие визуальных разрывов."
metadata: {"internal":true}
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


# Seam Craft — render prerequisites for scene-to-scene transitions

This is the **render-correctness doctrine** for PLV scene-to-scene seams: the
prerequisites and master-timeline mechanics that make any transition composite
correctly, independent of which specific transition is chosen. The per-transition
catalog (crossfade, push-slide, zoom-through, cut-the-curve, …) lives in the
transition registry — this page is the doctrine that sits underneath all of them.

The transitions this doctrine governs are **Tier-B-ready**: pure transform / opacity /
filter on the two scene **clip wrappers** (`#el-<sid>`), no injected overlay DOM, no
per-scene cooperation. Overlay families (staggered blocks, blinds, light leak, grid
dissolve, page burn) and shader transitions are deferred to later phases.

## Stage ground prerequisite (white-flash guard)

Several templates open a window where the two wrappers' summed opacity < 1 (the
cut-the-curve mid-window cut, zoom-through's 0.15 floor, plain crossfade's
power-curve dip). Whatever is BEHIND the wrappers shows through during that
window. If the assembled `index.html` `#root` has no opaque background, the
renderer composites the dip over its default **white** page → a white flash at
every seam, glaring on dark films (observed on two Spotify runs before the fix).
**The assembler must paint the stage:** `#root { background:
var(--canvas-deep, var(--canvas, #000)) }` — `assemble-index.mjs` now emits this;
any other consumer of these templates owns the same guarantee.

## How the injector applies a transition

At a `break` boundary between scene _i_ (`from`) and scene _i+1_ (`to`), the
injector:

1. Extends `#el-<from>` wrapper `data-duration` by `duration_s` (holds its final
   frame — verified: `core/src/runtime/init.ts:1393-1410` external-slot branch).
2. Pulls `#el-<to>` wrapper `data-start` earlier by `duration_s` (creates the
   overlap window).
3. Reassigns **all** clip `data-track-index` as a 0/1 ping-pong so the two
   overlapping wrappers never share a track (same-track overlap is illegal —
   `core/src/lint/rules/composition.ts`). Higher track composites on top.
4. Stamps the `gsap_template` into `window.__timelines["main"]` at `T = overlap-start`.

Verified by prototype render (2026-05-31): the master-timeline wrapper tween is
seeked and rendered (no double-seek with the sub-comp's own paused timeline —
the runtime drives them independently), the extended wrapper holds scene _i_'s
final frame, and the higher-track incoming wrapper composites over + blends with
the outgoing one.

## Template placeholders

The injector substitutes these tokens in each `gsap_template` line:

| Token                              | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `__OLD__`                          | `"#el-<from>"` — outgoing clip wrapper selector (quoted)                 |
| `__NEW__`                          | `"#el-<to>"` — incoming clip wrapper selector (quoted)                   |
| `__T__`                            | overlap-start time in seconds (master clock)                             |
| `__DUR__`                          | `duration_s` for this boundary                                           |
| `__DX__`                           | horizontal travel for directional types: `-1920` (LEFT) / `1920` (RIGHT) |
| `__DY__`                           | vertical travel: `-1080` (UP) / `1080` (DOWN)                            |
| `__ORIGIN_OUT__` / `__ORIGIN_IN__` | transformOrigin pair for `squeeze`                                       |

`filter` / `scaleX` / `transformOrigin` are lint-clean on the master timeline
(verified: `core/src/lint/rules/gsap.ts` has no per-property whitelist and scopes
its checks to `data-composition-id` ranges; the x/y/scale/rotation/opacity
whitelist is a _scene-worker_ prompt rule only — it does not bind index.html).
