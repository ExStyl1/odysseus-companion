# Icons

Sources, skills, and statuses can each carry an icon. An icon can be an emoji, or an image file — SVG, PNG, or JPG — that lives next to the entity's config.

::: info
Labels do **not** use icons; they render as colored circles. See [Colors](./colors) for label color configuration.
:::

## Supported formats

| Format | Extensions | Best for |
| --- | --- | --- |
| SVG | `.svg` | Scalable icons; adapts to the theme via `currentColor` |
| PNG | `.png` | Raster icons that need transparency |
| JPG | `.jpg`, `.jpeg` | Photos or complex artwork |
| Emoji | Unicode | Instant identity with no file |

## Setting an icon

### Emoji

Set the `icon` field in the entity's `config.json` to any Unicode emoji:

```json
{
  "icon": "🔧"
}
```

Multi-codepoint emojis and ZWJ sequences work too (for example `👨‍💻` or `🇭🇺`).

### Icon files (auto-discovered)

Drop an image named `icon.{svg,png,jpg,jpeg}` into the entity's directory and it is picked up automatically — you do **not** point at it from `config.json`:

```
sources/
  linear/
    config.json
    icon.svg        ← auto-discovered
```

When several formats are present, the first match wins in this order: **SVG → PNG → JPG → JPEG**.

::: info
The `icon` field only accepts an emoji or an `http(s)` URL. Inline SVG markup and relative file paths (such as `./icon.svg`) are rejected on purpose to keep configs clean — use auto-discovery for a local file instead.
:::

### URL (sources only)

If a source's `icon` field holds an `http(s)` URL, Nessy Desktop downloads the image once to a local `icon.{ext}` file in the source directory and renders from that file afterwards.

## Resolution order

When rendering an entity's icon, Nessy Desktop resolves it in this order:

1. **Emoji** — if `icon` is an emoji string, render it as text.
2. **URL** — if `icon` is an `http(s)` URL, download it to a local file and use that.
3. **Auto-discovery** — probe for `icon.svg`, `icon.png`, `icon.jpg`, `icon.jpeg` in the entity directory.
4. **Favicon fallback** (sources only) — derive one from the service URL (the MCP url or the API baseUrl).
5. **Fallback icon** — a generic placeholder is shown when nothing else resolves.

## SVG theming

SVGs that reference `currentColor` adapt to the active theme and entity color:

```xml
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor"/>
</svg>
```

How it behaves:

- An SVG that uses `currentColor` is treated as **colorable** — it inherits color from its context, so a status icon takes on its status color and the icon tracks light/dark mode.
- An SVG with hardcoded colors renders exactly as authored.
- Colorable SVGs are rendered inline so parent color classes cascade into the fills and strokes.

::: tip
Reach for `currentColor` in any icon that should match its entity's color (such as statuses) or follow the appearance mode.
:::

## Where each entity keeps its icon

### Sources

```
~/.nessy-agent/workspaces/{id}/sources/{slug}/
  config.json     ← "icon": "🔧" or an http(s) URL
  icon.svg        ← auto-discovered local file
```

Sources also have the favicon fallback: with no emoji, URL, or local file present, Nessy Desktop derives an icon from whichever service address the source carries — its MCP endpoint or its API base URL.

### Skills

```
~/.nessy-agent/workspaces/{id}/skills/{slug}/
  SKILL.md
  icon.svg        ← auto-discovered
```

Skills rely on the same auto-discovery. Once resolved, the file path lands on the skill's metadata under `iconPath`.

### Statuses

Status icons are auto-discovered from a dedicated `statuses/icons/` folder, named after the status id:

```
~/.nessy-agent/workspaces/{id}/statuses/
  config.json         ← status definitions
  icons/
    in-progress.svg   ← discovered for status id "in-progress"
    done.svg          ← discovered for status id "done"
```

## Icon sizes

Icons render at a fixed set of sizes across the UI:

| Size | Dimensions | Where it appears |
| --- | --- | --- |
| `xs` | 14px | Inline mentions, compact lists |
| `sm` | 16px | Sidebar items, badges |
| `md` | 20px | Default size, list items |
| `lg` | 24px | Headers, prominent placements |
| `xl` | 28px | Large displays |

## Tips

- **Prefer SVG.** It scales cleanly at every size and can follow theme colors through `currentColor`.
- **Keep SVGs lean.** Strip editor metadata and inline styles; a clean `viewBox` with `fill="currentColor"` paths and no `width`/`height` on the root works best.
- **Emoji for a quick start.** Emojis need no files and render natively — ideal when a custom file is not worth the effort.
- **Icon not showing?** Confirm the file is in the right directory for the entity type, the filename matches (`icon.svg` for sources and skills, `icons/{id}.svg` for statuses), and the SVG is valid XML. For URL icons, check that the file actually downloaded (look for `icon.{ext}` in the entity directory).
