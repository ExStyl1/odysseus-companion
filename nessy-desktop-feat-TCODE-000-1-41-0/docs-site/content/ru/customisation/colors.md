# Colors

Labels и statuses в Nessy Desktop принимают optional field `color`, driven by single shared type `EntityColor`. Value либо points at one of theme semantic colors — and then follows every theme and light/dark switch automatically — либо задаёт exact CSS color.

## EntityColor Value

Two shapes accepted wherever `color` field appears:

### System Colors

Plain string naming one of five design-system colors. Each name resolves to CSS variable from active [theme](./themes), so rendered color tracks theme changes and light/dark mode:

```json
{
  "color": "accent"
}
```

| Name | Default look | Typical meaning |
| ---- | ------------ | --------------- |
| `accent` | Purple | Brand highlight, primary actions, акценты режимов Plan и Bypass permissions |
| `info` | Amber | Attention, warnings, Ask mode |
| `success` | Green | Finished, connected, healthy |
| `destructive` | Red | Failures, errors, deletion |
| `foreground` | Text color | Neutral and muted states |

### System Colors with Opacity

Add `/{opacity}` after name, where opacity is whole number from 0 to 100:

```json
{
  "color": "foreground/50"
}
```

Under the hood this renders through `color-mix` against transparent, producing faded variant of base color. Useful combinations:

* `"accent/80"` — accent at 80% strength
* `"destructive/60"` — softened red
* `"foreground/30"` — barely-there text tint for de-emphasized items

::: warning
Opacity is percentage integer, not fraction. Write `"foreground/50"`, never `"foreground/0.5"`, and keep 100 or below — out-of-range or non-numeric suffix makes whole value fall back to plain foreground color.
:::

### Custom Colors

Object with `light` value and optional `dark`, when system colors do not fit:

```json
{
  "color": {
    "light": "#EF4444",
    "dark": "#F87171"
  }
}
```

When `dark` omitted, Nessy Desktop derives it from `light`:

* **Hex values** lightened by mixing 30% white into color.
* **Every other format** (OKLCH, RGB, HSL) passes unchanged — for those set `dark` yourself or modes look identical.

```json
{
  "color": {
    "light": "#3B82F6"
  }
}
```

## Accepted Color Formats

Custom entity colors validate against:

| Format | Examples |
| ------ | -------- |
| Hex | `#f43`, `#8b5cf6`, `#8b5cf6cc` (8-digit = alpha) |
| RGB | `rgb(139, 92, 246)`, `rgba(139, 92, 246, 0.8)` |
| HSL | `hsl(262, 83%, 58%)`, `hsla(262, 83%, 58%, 0.8)` |
| OKLCH | `oklch(0.58 0.22 293)`, `oklch(0.58 0.22 293 / 0.8)` |

::: info
Named CSS colors such as `purple` accepted in [theme files](./themes), but **not** in entity `color` fields. For entities, use four formats above. OKLCH is most predictable; plain hex plus automatic dark derivation covers simple cases.
:::

## Where Colors Apply

### Labels

Label renders as colored circle — no label icon — and `color` decides fill:

```json
{
  "id": "bug",
  "name": "Bug",
  "color": "destructive"
}
```

```json
{
  "id": "feature",
  "name": "Feature",
  "color": {
    "light": "#8B5CF6",
    "dark": "#A78BFA"
  }
}
```

Label without `color` shows muted foreground dot. See [Labels](../labels/overview) for rest of label config, including [auto-apply rules](../labels/auto-rules) — automatically applied labels use same color label defines.

### Statuses

Status uses its color for status icon and related indicators:

```json
{
  "id": "in-progress",
  "label": "In Progress",
  "color": "success",
  "category": "open"
}
```

When status omits `color`, built-in palette applies:

| Status ID | Default color | Look |
| --------- | ------------- | ---- |
| `backlog` | `foreground/50` | Muted |
| `todo` | `foreground/50` | Muted |
| `in-progress` | `success` | Green |
| `needs-review` | `info` | Amber |
| `done` | `accent` | Purple |
| `cancelled` | `foreground/50` | Muted |

Any other status ID without explicit color falls back to `foreground/50`. Full status file format lives in [Customizing Statuses](../statuses/customizing).

## How Colors Relate to Themes

Five system names resolve to exact CSS variables populated by [theme](./themes). Consequences:

* Entity colors restyle themselves the moment theme changes.
* `"color": "accent"` is purple on stock theme, but becomes whatever preset or `theme.json` assigns to `accent`.
* Custom `{ light, dark }` objects ignore theme entirely and render literal values.

## OKLCH Cheat Sheet

OKLCH written as `oklch(lightness chroma hue)`:

| Component | Range | Meaning |
| --------- | ----- | ------- |
| Lightness | 0–1 | 0 is black, 1 is white |
| Chroma | 0–0.4 | 0 is gray; larger means more vivid |
| Hue | 0–360 | Position on color wheel |

Rough hue anchors: red ≈ 25, orange ≈ 70, yellow ≈ 100, green ≈ 145, cyan ≈ 195, blue ≈ 250, purple ≈ 293, pink ≈ 330.

## Examples

System color, shortest form:

```json
{ "color": "success" }
```

Muted secondary state:

```json
{ "color": "foreground/40" }
```

Brand color tuned separately per mode:

```json
{
  "color": {
    "light": "oklch(0.55 0.20 250)",
    "dark": "oklch(0.70 0.18 250)"
  }
}
```

Hex with dark variant derived automatically:

```json
{
  "color": {
    "light": "#059669"
  }
}
```

## Tips

* **Reach for system colors first.** They follow themes and modes for free; custom values needed only when five names cannot express brand shade.
* **Build hierarchy with opacity.** `foreground/50` and `foreground/30` communicate secondary/disabled without adding hues.
* **Check both modes.** With custom colors — especially non-hex — flip light/dark and confirm readability.

## Troubleshooting

If color does not show as expected:

* `color` field must sit at top level of entity entry, not nested.
* System names are lowercase and case-sensitive: `"accent"` works, `"Accent"` does not.
* Custom object needs at least `light`.
* Invalid system strings silently degrade to default foreground color — check spelling and opacity suffix.
