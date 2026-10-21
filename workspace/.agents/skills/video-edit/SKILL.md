---
name: "video-edit"
description: "Локальный монтаж FFmpeg: обрезка, склейка, скорость, наложения, звук и экспорт."
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


# Video Edit

Edit videos locally by running ffmpeg/ffprobe directly. No wrapper scripts needed.

## Prerequisites

Install ffmpeg (includes ffprobe):

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install -y ffmpeg

# Verify
ffmpeg -version && ffprobe -version
```

## Quick Reference

### Get video info

```bash
ffprobe -v quiet -print_format json -show_format -show_streams video.mp4
```

### Trim

```bash
ffmpeg -y -ss 00:00:30 -to 00:01:45 -i video.mp4 -c copy trimmed.mp4
```

### Concatenate clips

```bash
# 1. Create a file list
printf "file '%s'\n" clip1.mp4 clip2.mp4 clip3.mp4 > list.txt

# 2. Concat with stream copy
ffmpeg -y -f concat -safe 0 -i list.txt -c copy joined.mp4
```

### Resize for platform

```bash
ffmpeg -y -i video.mp4 \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" \
  -c:a copy tiktok.mp4
```

### Change speed

```bash
# 2x faster
ffmpeg -y -i video.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" fast.mp4

# 0.5x (slow motion)
ffmpeg -y -i video.mp4 -filter:v "setpts=2.0*PTS" -filter:a "atempo=0.5" slow.mp4
```

### Extract audio

```bash
ffmpeg -y -i video.mp4 -vn -acodec libmp3lame audio.mp3
```

### Replace audio

```bash
ffmpeg -y -i video.mp4 -i audio.mp3 -c:v copy -map 0:v:0 -map 1:a:0 -shortest output.mp4
```

### Compress

```bash
ffmpeg -y -i video.mp4 -crf 23 -preset medium -c:a copy compressed.mp4
```

### Convert format

```bash
ffmpeg -y -i video.mov output.mp4
```

### Add image overlay

```bash
# Logo in top-right corner
ffmpeg -y -i video.mp4 -i logo.png \
  -filter_complex "overlay=W-w-10:10" -c:a copy watermarked.mp4
```

## Platform Presets

| Platform   | Resolution  | Scale + pad filter                                                                                    |
|------------|-------------|-------------------------------------------------------------------------------------------------------|
| TikTok     | 1080 x 1920 | `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black`       |
| YouTube    | 1920 x 1080 | `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black`       |
| Instagram  | 1080 x 1350 | `scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:black`       |
| Square     | 1080 x 1080 | `scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black`       |
| Twitter/X  | 1920 x 1080 | `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black`       |

Use the filter with: `ffmpeg -y -i input.mp4 -vf "<filter>" -c:a copy output.mp4`

## Tips

- Always use `-y` to overwrite output without prompting.
- Use `-c copy` when you only need to cut/join (no re-encoding, very fast).
- Lower CRF = better quality, larger file. Range 18-28 is typical; 23 is the default.
- For detailed recipes and flag explanations, see `references/operations.md`.
