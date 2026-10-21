# Themes

Nessy Desktop uses a six-color semantic theme. You can nudge a single color, override several, or drop in a complete preset theme package. For a deeper walkthrough of what each color drives across the UI, see [Colors](./colors).

## How themes resolve

Themes are applied app-wide (there is no per-workspace cascade), in this order of precedence:

1. **Selected preset** — the preset chosen in Settings → Appearance, stored as `colorTheme` in `~/.nessy-agent/config.json`. Default is `"default"`.
2. **Preset files** — complete theme packages in `~/.nessy-agent/themes/{name}.json`.
3. **Override file** — `~/.nessy-agent/theme.json`, which patches specific colors on top of the base.

## The six-color system

| Color | Purpose | Where it shows |
| --- | --- | --- |
| `background` | Surface / page background | The light or dark base surface |
| `foreground` | Text and icons | Primary text color |
| `accent` | Brand color, the Plan and Bypass permissions modes | Highlights, active states, the purple UI accents |
| `info` | Ask mode, warnings | Amber attention states |
| `success` | Connected status | Green checkmarks and success states |
| `destructive` | Errors, destructive actions | Red alerts and failed states |

## Override file

Create `~/.nessy-agent/theme.json` to patch only the colors you care about:

```json
{
  "accent": "oklch(0.58 0.22 293)",
  "dark": {
    "accent": "oklch(0.65 0.22 293)"
  }
}
```

Every field is optional — specify only what you want to change; everything else falls back to the default theme.

## Dark mode

The optional `dark` object overrides colors when the system is in dark mode:

1. The top-level (base) colors act as the light-mode defaults.
2. Any color inside `dark` replaces its base value in dark mode.

This lets you do partial dark-mode tuning — only override what needs to differ.

## Preset themes

Presets are complete packages stored at `~/.nessy-agent/themes/`. Each is a JSON file carrying the theme colors plus metadata.

### Preset schema

```json
{
  "name": "Dracula",
  "description": "A dark theme with vibrant colors",
  "author": "Zeno Rocha",
  "license": "MIT",
  "source": "https://draculatheme.com",
  "supportedModes": ["dark"],

  "background": "oklch(0.22 0.02 280)",
  "foreground": "oklch(0.95 0.01 270)",
  "accent": "oklch(0.70 0.20 320)",
  "info": "oklch(0.78 0.14 70)",
  "success": "oklch(0.72 0.18 145)",
  "destructive": "oklch(0.65 0.22 28)",

  "shikiTheme": {
    "light": "github-light",
    "dark": "dracula"
  }
}
```

### Metadata fields

| Field | Description |
| --- | --- |
| `name` | Display name |
| `description` | Short description |
| `author` | Theme creator |
| `license` | License type (MIT, and so on) |
| `source` | URL to the original theme |
| `supportedModes` | Array of `"light"`, `"dark"`, or both |
| `shikiTheme` | Syntax-highlighting theme, with `light`/`dark` variants |

### Installing a preset

1. Download or write a theme JSON file.
2. Save it to `~/.nessy-agent/themes/{name}.json`.
3. Select it in Settings → Appearance.

## Scenic mode

Scenic mode trades the flat surfaces for a photo that fills the whole window, with frosted, glass-like panels floating over it.

### Turning it on

```json
{
  "mode": "scenic",
  "backgroundImage": "https://example.com/mountains.jpg",

  "background": "oklch(0.15 0.02 270 / 0.8)",
  "paper": "oklch(0.18 0.02 270 / 0.6)",
  "navigator": "oklch(0.12 0.02 270 / 0.7)",
  "popoverSolid": "oklch(0.18 0.02 270)"
}
```

| Property | Description |
| --- | --- |
| `mode` | Set to `"scenic"` (default is `"solid"`) |
| `backgroundImage` | Image URL (JPEG, PNG, or WebP recommended); required when `mode` is `"scenic"` |

### Surface colors for glass panels

Scenic mode looks best with semi-transparent surface colors so the background image shows through:

| Color | Purpose |
| --- | --- |
| `paper` | AI messages, cards, elevated content |
| `navigator` | Left sidebar background |
| `input` | Input field background |
| `popover` | Dropdowns, modals, context menus |
| `popoverSolid` | Guaranteed fully opaque popover background (needed in scenic mode) |

Surface colors are optional everywhere and fall back to `background` when unset.

## Color formats

Any valid CSS color works:

| Format | Example |
| --- | --- |
| Hex | `#8b5cf6`, `#8b5cf6cc` (with alpha) |
| RGB | `rgb(139, 92, 246)`, `rgba(139, 92, 246, 0.8)` |
| HSL | `hsl(262, 83%, 58%)` |
| OKLCH | `oklch(0.58 0.22 293)` |
| Named | `purple`, `rebeccapurple` |

::: info
OKLCH is recommended. It is perceptually uniform, so colors stay consistent between light and dark modes.
:::

## OKLCH reference

OKLCH is written `oklch(lightness chroma hue)`:

| Component | Range | Meaning |
| --- | --- | --- |
| Lightness | 0–1 | 0 = black, 1 = white |
| Chroma | 0–0.4 | 0 = gray, higher = more saturated |
| Hue | 0–360 | Angle on the color wheel |

Common hues: red ~25, orange ~70, yellow ~100, green ~145, cyan ~195, blue ~250, purple ~293, pink ~330.

## Examples

Just change the accent:

```json
{
  "accent": "#3b82f6"
}
```

Custom brand colors with dark-mode variants:

```json
{
  "accent": "oklch(0.55 0.25 250)",
  "info": "oklch(0.70 0.15 200)",
  "dark": {
    "accent": "oklch(0.65 0.25 250)",
    "info": "oklch(0.75 0.12 200)"
  }
}
```

High-contrast:

```json
{
  "background": "#ffffff",
  "foreground": "#000000",
  "dark": {
    "background": "#000000",
    "foreground": "#ffffff"
  }
}
```

## Live updates

Theme changes apply immediately — no restart. Edit `theme.json` and the UI updates on the fly.

## Review checklist

After a theme change, glance over onboarding, settings, session lists, code blocks, command output, labels, and permission badges in **both** light and dark modes to be sure everything stays readable.

## Troubleshooting

**Theme not applying**

- Check the JSON is valid.
- Confirm the file is in the right place (`~/.nessy-agent/theme.json` for overrides, `~/.nessy-agent/themes/` for presets).
- Make sure every value is a valid CSS color.

**Colors look wrong in dark mode**

- Add explicit `dark` overrides.
- OKLCH colors often need a higher lightness in dark mode.
- Check whether the preset's `supportedModes` excludes your current mode.

**Background image not showing**

- Confirm `mode` is `"scenic"`.
- Check the image URL is valid and reachable.

## Tips

- **Start with just the accent.** Changing one color is the fastest way to make the app feel yours.
- **Use OKLCH for predictability.** It behaves more consistently across modes than hex or RGB.
- **Test both modes.** Always check light and dark before settling on a theme.
- **Keep contrast accessible.** Leave enough separation between foreground and background.
