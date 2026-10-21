---
name: "video-understand"
description: "Локальный анализ видео по извлечённым кадрам и расшифровке речи с установленным Whisper."
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


# video-understand

Understand video content locally using ffmpeg for frame extraction and Whisper for transcription. Fully offline, no API keys required.

## Prerequisites

- `ffmpeg` + `ffprobe` (required): `brew install ffmpeg`
- `openai-whisper` (optional, for transcription): `pip install openai-whisper`

## Commands

```bash
# Scene detection + transcribe (default)
python3 skills/video-understand/scripts/understand_video.py video.mp4

# Keyframe extraction
python3 skills/video-understand/scripts/understand_video.py video.mp4 -m keyframe

# Regular interval extraction
python3 skills/video-understand/scripts/understand_video.py video.mp4 -m interval

# Limit frames extracted
python3 skills/video-understand/scripts/understand_video.py video.mp4 --max-frames 10

# Use a larger Whisper model
python3 skills/video-understand/scripts/understand_video.py video.mp4 --whisper-model small

# Frames only, skip transcription
python3 skills/video-understand/scripts/understand_video.py video.mp4 --no-transcribe

# Quiet mode (JSON only, no progress)
python3 skills/video-understand/scripts/understand_video.py video.mp4 -q

# Output to file
python3 skills/video-understand/scripts/understand_video.py video.mp4 -o result.json
```

## CLI Options

| Flag | Description |
|------|-------------|
| `video` | Input video file (positional, required) |
| `-m, --mode` | Extraction mode: `scene` (default), `keyframe`, `interval` |
| `--max-frames` | Maximum frames to keep (default: 20) |
| `--whisper-model` | Whisper model size: tiny, base, small, medium, large (default: base) |
| `--no-transcribe` | Skip audio transcription, extract frames only |
| `-o, --output` | Write result JSON to file instead of stdout |
| `-q, --quiet` | Suppress progress messages, output only JSON |

## Extraction Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| `scene` | Detects scene changes via ffmpeg `select='gt(scene,0.3)'` | Most videos, varied content |
| `keyframe` | Extracts I-frames (codec keyframes) | Encoded video with natural keyframe placement |
| `interval` | Evenly spaced frames based on duration and max-frames | Fixed sampling, predictable output |

If `scene` mode detects no scene changes, it automatically falls back to `interval` mode.

## Output

The script outputs JSON to stdout (or file with `-o`). See `references/output-format.md` for the full schema.

```json
{
  "video": "video.mp4",
  "duration": 18.076,
  "resolution": {"width": 1224, "height": 1080},
  "mode": "scene",
  "frames": [
    {"path": "/abs/path/frame_0001.jpg", "timestamp": 0.0, "timestamp_formatted": "00:00"}
  ],
  "frame_count": 12,
  "transcript": [
    {"start": 0.0, "end": 2.5, "text": "Hello and welcome..."}
  ],
  "text": "Full transcript...",
  "note": "Use the Read tool to view frame images for visual understanding."
}
```

Use the Read tool on frame image paths to visually inspect extracted frames.

## References

- `references/output-format.md` -- Full JSON output schema documentation
