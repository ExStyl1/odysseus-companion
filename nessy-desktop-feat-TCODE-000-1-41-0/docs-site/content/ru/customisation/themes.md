# Themes

Nessy Desktop uses six-color semantic theme. Можно tweak one color, override several или drop complete preset theme package. For deeper walkthrough of what each color drives across UI, see [Colors](./colors).

## How themes resolve

Themes applied app-wide (no per-workspace cascade), in order:

1. **Selected preset** — preset chosen in Settings → Appearance, stored as `colorTheme` in `~/.nessy-agent/config.json`. Default is `"default"`.
2. **Preset files** — complete theme packages in `~/.nessy-agent/themes/{name}.json`.
3. **Override file** — `~/.nessy-agent/theme.json`, patches specific colors on top of base.

## The six-color system

| Color | Purpose | Where it shows |
| --- | --- | --- |
| `background` | Surface / page background | Light or dark base surface |
| `foreground` | Text and icons | Primary text color |
| `accent` | Brand color, режимы Plan и Bypass permissions | Highlights, active states, purple UI accents |
| `info` | Ask mode, warnings | Amber attention states |
| `success` | Connected status | Green checkmarks and success states |
| `destructive` | Errors, destructive actions | Red alerts and failed states |

## Override file

Create `~/.nessy-agent/theme.json` to patch only colors you care about:

```json
{
  "accent": "oklch(0.58 0.22 293)",
  "dark": {
    "accent": "oklch(0.65 0.22 293)"
  }
}
```

Every field optional — specify only what changes; everything else falls back to default theme.

## Dark mode

Optional `dark` object overrides colors when system is in dark mode:

1. Top-level (base) colors act as light-mode defaults.
2. Any color inside `dark` replaces base value in dark mode.

This lets you do partial dark-mode tuning — only override what needs to differ.

## Preset themes

Presets are complete packages stored at `~/.nessy-agent/themes/`. Each JSON file carries theme colors plus metadata.

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
| `source` | URL to original theme |
| `supportedModes` | Array of `"light"`, `"dark"`, or both |
| `shikiTheme` | Syntax-highlighting theme, with `light`/`dark` variants |

### Installing a preset

1. Download or write theme JSON file.
2. Save it to `~/.nessy-agent/themes/{name}.json`.
3. Select it in Settings → Appearance.

## Scenic mode

Scenic mode trades flat surfaces for photo filling whole window, with frosted glass-like panels over it.

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
| `backgroundImage` | Image URL (JPEG, PNG or WebP recommended); required when `mode` is `"scenic"` |

### Surface colors for glass panels

Scenic mode looks best with semi-transparent surface colors so background image shows through:

| Color | Purpose |
| --- | --- |
| `paper` | AI messages, cards, elevated content |
| `navigator` | Left sidebar background |
| `input` | Input field background |
| `popover` | Dropdowns, modals, context menus |
| `popoverSolid` | Guaranteed fully opaque popover background (needed in scenic mode) |

Surface colors optional everywhere and fall back to `background` when unset.

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
OKLCH recommended. It is perceptually uniform, so colors stay consistent between light and dark modes.
:::

## OKLCH reference

OKLCH written `oklch(lightness chroma hue)`:

| Component | Range | Meaning |
| --- | --- | --- |
| Lightness | 0–1 | 0 = black, 1 = white |
| Chroma | 0–0.4 | 0 = gray, higher = more saturated |
| Hue | 0–360 | Angle on color wheel |

Common hues: red ~25, orange ~70, yellow ~100, green ~145, cyan ~195, blue ~250, purple ~293, pink ~330.

## Examples

Just change accent:

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

Theme changes apply immediately — no restart. Edit `theme.json`, and UI updates on the fly.

## Review checklist

After theme change, glance over onboarding, settings, session lists, code blocks, command output, labels and permission badges in **both** light and dark modes.

## Troubleshooting

**Theme not applying**

- Check JSON valid.
- Confirm file in right place (`~/.nessy-agent/theme.json` for overrides, `~/.nessy-agent/themes/` for presets).
- Make sure every value is valid CSS color.

**Colors look wrong in dark mode**

- Add explicit `dark` overrides.
- OKLCH colors often need higher lightness in dark mode.
- Check whether preset `supportedModes` excludes current mode.

**Background image not showing**

- Confirm `mode` is `"scenic"`.
- Check image URL valid and reachable.

## Tips

- **Start with just accent.** Changing one color is fastest way to make app feel yours.
- **Use OKLCH for predictability.** More consistent across modes than hex or RGB.
- **Test both modes.** Always check light and dark before settling on theme.
- **Keep contrast accessible.** Leave enough separation between foreground and background.
