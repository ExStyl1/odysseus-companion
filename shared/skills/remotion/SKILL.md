---
name: "remotion"
description: "Применение проектных компонентов и переходов Remotion для создания локальных видео на React."
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


# Remotion — Toolkit Extensions

> **Core Remotion knowledge** lives in `.claude/skills/remotion-official/` (synced from the official [remotion-dev/skills](https://github.com/remotion-dev/skills) repo). This file covers **toolkit-specific** patterns only.

## Shared Components

Reusable video components in `lib/components/`. Import in templates via:

```tsx
import { AnimatedBackground, SlideTransition, Label } from '../../../../lib/components';
```

| Component | Purpose |
|-----------|---------|
| `AnimatedBackground` | Floating shapes background (variants: subtle, tech, warm, dark) |
| `SlideTransition` | Scene transitions (fade, zoom, slide-up, blur-fade) |
| `Label` | Floating label badge with optional JIRA reference |
| `Vignette` | Cinematic edge darkening overlay |
| `LogoWatermark` | Corner logo branding |
| `SplitScreen` | Side-by-side video comparison |
| `NarratorPiP` | Picture-in-picture presenter overlay |
| `Envelope` | 3D envelope with opening flap animation |
| `PointingHand` | Animated hand emoji with slide-in and pulse |
| `MazeDecoration` | Animated isometric grid decoration for corners |

## Custom Transitions

The toolkit includes a transitions library at `lib/transitions/` for scene-to-scene effects beyond the official `@remotion/transitions` package.

### Using TransitionSeries

```tsx
import { TransitionSeries, linearTiming } from '@remotion/transitions';
// Import custom transitions from lib (adjust path based on your project location)
import { glitch, lightLeak, clockWipe, checkerboard } from '../../../../lib/transitions';
// Or import from @remotion/transitions for official ones
import { slide, fade } from '@remotion/transitions/slide';

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={90}>
    <TitleSlide />
  </TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={glitch({ intensity: 0.8 })}
    timing={linearTiming({ durationInFrames: 30 })}
  />
  <TransitionSeries.Sequence durationInFrames={120}>
    <ContentSlide />
  </TransitionSeries.Sequence>
</TransitionSeries>
```

### Available Custom Transitions

| Transition | Options | Best For |
|------------|---------|----------|
| `glitch()` | `intensity`, `slices`, `rgbShift` | Tech demos, edgy reveals, cyberpunk |
| `rgbSplit()` | `direction`, `displacement` | Modern tech, energetic transitions |
| `zoomBlur()` | `direction`, `blurAmount` | CTAs, high-energy moments, impact |
| `lightLeak()` | `temperature`, `direction` | Celebrations, film aesthetic, warm moments |
| `clockWipe()` | `startAngle`, `direction`, `segments` | Time-related content, playful reveals |
| `pixelate()` | `maxBlockSize`, `gridSize`, `scanlines`, `glitchArtifacts`, `randomness` | Retro/gaming, digital transformations |
| `checkerboard()` | `gridSize`, `pattern`, `stagger`, `squareAnimation` | Playful reveals, structured transitions |

**Checkerboard patterns:** `sequential`, `random`, `diagonal`, `alternating`, `spiral`, `rows`, `columns`, `center-out`, `corners-in`

### Transition Examples

```tsx
// Tech/cyberpunk feel
glitch({ intensity: 0.8, slices: 8, rgbShift: true })

// Warm celebration
lightLeak({ temperature: 'warm', direction: 'right' })

// High energy zoom
zoomBlur({ direction: 'in', blurAmount: 20 })

// Chromatic aberration
rgbSplit({ direction: 'diagonal', displacement: 30 })

// Clock sweep reveal
clockWipe({ direction: 'clockwise', startAngle: 0 })

// Retro pixelation
pixelate({ maxBlockSize: 50, glitchArtifacts: true })

// Checkerboard patterns
checkerboard({ pattern: 'diagonal', gridSize: 8 })
checkerboard({ pattern: 'spiral', gridSize: 10 })
checkerboard({ pattern: 'center-out', squareAnimation: 'scale' })
```

### Transition Duration Guidelines

| Type | Frames | Notes |
|------|--------|-------|
| Quick cut | 15-20 | Fast, punchy |
| Standard | 30-45 | Most common |
| Dramatic | 50-60 | Slow reveals |
| Glitch effects | 20-30 | Should feel sudden |
| Light leak | 45-60 | Needs time to sweep |

### Preview Transitions

Run the showcase gallery to see all transitions:

```bash
cd showcase/transitions && npm run studio
```

## Toolkit Best Practices

1. **Frame-based animations only** — Avoid CSS transitions/animations; they cause flickering during render
2. **Use fps from useVideoConfig()** — Make animations frame-rate independent
3. **Clamp interpolations** — Use `extrapolateRight: 'clamp'` to prevent runaway values
4. **Use OffthreadVideo** — Better performance than `<Video>` for complex compositions
5. **delayRender for async** — Always block rendering until data is ready
6. **staticFile for assets** — Reference files from `public/` folder correctly
7. **All projects use 30fps** — Timing: frames = seconds × 30
8. **playbackRate must be constant** — For variable/extreme speeds, pre-process with FFmpeg

## Project Timing Conventions

| Scene Type | Duration | Notes |
|------------|----------|-------|
| Title | 3-5s (90-150f) | Logo + headline |
| Overview | 10-20s | 3-5 bullet points |
| Demo | 10-30s | Adjust playbackRate to fit |
| Stats | 8-12s | 3-4 stat cards |
| Credits | 5-10s | Quick fade |

**Pacing:** ~150 words/minute for voiceover. Voiceover drives timing.

## Advanced API

For detailed API documentation on all hooks, components, renderer, Lambda, and Player APIs, see [reference.md](reference.md).

## License Note

Remotion has a special license. Companies may need to obtain a license for commercial use. Check https://remotion.dev/license

---

## Feedback & Contributions

If this skill is missing information or could be improved:

- **Missing a pattern?** Describe what you needed
- **Found an error?** Let me know what's wrong
- **Want to contribute?** I can help you:
  1. Update this skill with improvements
  2. Create a PR to github.com/digitalsamba/claude-code-video-toolkit

Just say "improve this skill" and I'll guide you through updating `.claude/skills/remotion/SKILL.md`.
