# Icons

Sources, skills and statuses can each carry an icon. Icon can be emoji or image file — SVG, PNG or JPG — living next to entity config.

::: info
Labels do **not** use icons; they render as colored circles. See [Colors](./colors) for label color configuration.
:::

## Supported formats

| Format | Extensions | Best for |
| --- | --- | --- |
| SVG | `.svg` | Scalable icons; adapts to theme via `currentColor` |
| PNG | `.png` | Raster icons that need transparency |
| JPG | `.jpg`, `.jpeg` | Photos or complex artwork |
| Emoji | Unicode | Instant identity with no file |

## Setting an icon

### Emoji

Set `icon` field in entity `config.json` to any Unicode emoji:

```json
{
  "icon": "🔧"
}
```

Multi-codepoint emojis and ZWJ sequences work too (for example `👨‍💻` or `🇭🇺`).

### Icon files (auto-discovered)

Drop image named `icon.{svg,png,jpg,jpeg}` into entity directory and it is picked up automatically — do **not** point at it from `config.json`:

```
sources/
  linear/
    config.json
    icon.svg        ← auto-discovered
```

When several formats present, first match wins: **SVG → PNG → JPG → JPEG**.

::: info
Field `icon` accepts only emoji or `http(s)` URL. Inline SVG markup and relative file paths (such as `./icon.svg`) rejected on purpose to keep configs clean — use auto-discovery for local file.
:::

### URL (sources only)

If source `icon` field holds `http(s)` URL, Nessy Desktop downloads image once to local `icon.{ext}` file in source directory and renders from that file afterwards.

## Resolution order

When rendering entity icon, Nessy Desktop resolves:

1. **Emoji** — if `icon` is emoji string, render as text.
2. **URL** — if `icon` is `http(s)` URL, download to local file and use that.
3. **Auto-discovery** — probe for `icon.svg`, `icon.png`, `icon.jpg`, `icon.jpeg` in entity directory.
4. **Favicon fallback** (sources only) — derive one from service URL (MCP url or API baseUrl).
5. **Fallback icon** — generic placeholder when nothing resolves.

## SVG theming

SVGs referencing `currentColor` adapt to active theme and entity color:

```xml
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor"/>
</svg>
```

Behavior:

- SVG using `currentColor` treated as **colorable** — inherits color from context, so status icon takes status color and tracks light/dark mode.
- SVG with hardcoded colors renders as authored.
- Colorable SVGs rendered inline so parent color classes cascade into fills/strokes.

::: tip
Use `currentColor` in any icon that should match entity color (such as statuses) or follow appearance mode.
:::

## Where each entity keeps its icon

### Sources

```
~/.nessy-agent/workspaces/{id}/sources/{slug}/
  config.json     ← "icon": "🔧" or an http(s) URL
  icon.svg        ← auto-discovered local file
```

Sources also have favicon fallback: without emoji, URL or local file, Nessy Desktop derives icon from service address — MCP endpoint or API base URL.

### Skills

```
~/.nessy-agent/workspaces/{id}/skills/{slug}/
  SKILL.md
  icon.svg        ← auto-discovered
```

Skills rely on same auto-discovery. Once resolved, file path lands on skill metadata under `iconPath`.

### Statuses

Status icons auto-discovered from dedicated `statuses/icons/` folder, named after status id:

```
~/.nessy-agent/workspaces/{id}/statuses/
  config.json         ← status definitions
  icons/
    in-progress.svg   ← discovered for status id "in-progress"
    done.svg          ← discovered for status id "done"
```

## Icon sizes

Icons render at fixed sizes across UI:

| Size | Dimensions | Where it appears |
| --- | --- | --- |
| `xs` | 14px | Inline mentions, compact lists |
| `sm` | 16px | Sidebar items, badges |
| `md` | 20px | Default size, list items |
| `lg` | 24px | Headers, prominent placements |
| `xl` | 28px | Large displays |

## Tips

- **Prefer SVG.** It scales cleanly and can follow theme colors through `currentColor`.
- **Keep SVGs lean.** Strip editor metadata and inline styles; clean `viewBox` with `fill="currentColor"` paths and no root `width`/`height` works best.
- **Emoji for quick start.** Emojis need no files and render natively.
- **Icon not showing?** Confirm file is in right directory, filename matches (`icon.svg` for sources/skills, `icons/{id}.svg` for statuses), and SVG valid XML. For URL icons, check file downloaded (`icon.{ext}` in entity directory).
