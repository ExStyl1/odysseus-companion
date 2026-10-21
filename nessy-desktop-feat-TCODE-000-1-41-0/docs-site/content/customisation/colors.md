# Colors

Labels and statuses in Nessy Desktop take an optional `color` field driven by a single shared type, `EntityColor`. A value either points at one of the theme's semantic colors — and then follows every theme and light/dark switch automatically — or spells out an exact CSS color of your own.

## The EntityColor Value

Two shapes are accepted wherever a `color` field appears:

### System Colors

A plain string naming one of the five design-system colors. Each name resolves to a CSS variable supplied by the active [theme](./themes), so the rendered color tracks theme changes and the light/dark mode without any extra work:

```json
{
  "color": "accent"
}
```

| Name          | Default look | Typical meaning                          |
| ------------- | ------------ | ---------------------------------------- |
| `accent`      | Purple       | Brand highlight, primary actions, the Plan and Bypass permissions mode accents |
| `info`        | Amber        | Attention, warnings, Ask mode            |
| `success`     | Green        | Finished, connected, healthy             |
| `destructive` | Red          | Failures, errors, deletion               |
| `foreground`  | Text color   | Neutral and muted states                 |

### System Colors with Opacity

Add `/{opacity}` after the name, where the opacity is a whole number from 0 to 100:

```json
{
  "color": "foreground/50"
}
```

Under the hood this renders through `color-mix` against transparent, producing a faded variant of the base color. A few useful combinations:

* `"accent/80"` — accent at 80% strength
* `"destructive/60"` — softened red
* `"foreground/30"` — barely-there text tint for de-emphasized items

::: warning
The opacity is a percentage integer, not a fraction. Write `"foreground/50"`, never `"foreground/0.5"`, and keep it at 100 or below — out-of-range or non-numeric suffixes make the whole value fall back to the plain foreground color.
:::

### Custom Colors

An object with a `light` value and, optionally, a `dark` one, when none of the system colors fit:

```json
{
  "color": {
    "light": "#EF4444",
    "dark": "#F87171"
  }
}
```

When `dark` is left out, Nessy Desktop derives it from `light`:

* **Hex values** are lightened by mixing 30% white into the color.
* **Every other format** (OKLCH, RGB, HSL) passes through unchanged — for those, set `dark` yourself or the two modes will look identical.

```json
{
  "color": {
    "light": "#3B82F6"
  }
}
```

## Accepted Color Formats

Custom entity colors are validated against these formats:

| Format | Examples                                        |
| ------ | ----------------------------------------------- |
| Hex    | `#f43`, `#8b5cf6`, `#8b5cf6cc` (8-digit = alpha) |
| RGB    | `rgb(139, 92, 246)`, `rgba(139, 92, 246, 0.8)`  |
| HSL    | `hsl(262, 83%, 58%)`, `hsla(262, 83%, 58%, 0.8)` |
| OKLCH  | `oklch(0.58 0.22 293)`, `oklch(0.58 0.22 293 / 0.8)` |

::: info
Named CSS colors such as `purple` are accepted in [theme files](./themes) but **not** in entity `color` fields. For entities, stick to the four formats above. OKLCH is the most predictable choice; plain hex plus the automatic dark derivation covers simple cases well.
:::

## Where Colors Apply

### Labels

A label renders as a colored circle — there is no label icon — and the `color` field decides the circle's fill:

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

A label with no `color` shows up as a muted foreground dot. See [Labels](../labels/overview) for the rest of the label config, including [auto-apply rules](../labels/auto-rules) — automatically applied labels use the same color the label defines.

### Statuses

A status uses its color for the status icon and related indicators:

```json
{
  "id": "in-progress",
  "label": "In Progress",
  "color": "success",
  "category": "open"
}
```

When a status omits `color`, a built-in palette kicks in:

| Status ID      | Default color   | Look   |
| -------------- | --------------- | ------ |
| `backlog`      | `foreground/50` | Muted  |
| `todo`         | `foreground/50` | Muted  |
| `in-progress`  | `success`       | Green  |
| `needs-review` | `info`          | Amber  |
| `done`         | `accent`        | Purple |
| `cancelled`    | `foreground/50` | Muted  |

Any other status ID without an explicit color falls back to `foreground/50`. The full status file format lives in [Customizing Statuses](../statuses/customizing).

## How Colors Relate to Themes

The five system names resolve to the exact CSS variables your [theme](./themes) populates. Consequences worth knowing:

* Entity colors restyle themselves the moment the theme changes — nothing to edit.
* `"color": "accent"` is purple on the stock theme, but becomes whatever a preset or `theme.json` override assigns to `accent`.
* Custom `{ light, dark }` objects ignore the theme entirely; they render the literal values you wrote.

## OKLCH Cheat Sheet

OKLCH is written as `oklch(lightness chroma hue)`:

| Component | Range | Meaning                              |
| --------- | ----- | ------------------------------------ |
| Lightness | 0–1   | 0 is black, 1 is white               |
| Chroma    | 0–0.4 | 0 is gray; larger means more vivid   |
| Hue       | 0–360 | Position on the color wheel          |

Rough hue anchors: red ≈ 25, orange ≈ 70, yellow ≈ 100, green ≈ 145, cyan ≈ 195, blue ≈ 250, purple ≈ 293, pink ≈ 330.

## Examples

A system color, the shortest form:

```json
{ "color": "success" }
```

A muted secondary state:

```json
{ "color": "foreground/40" }
```

A brand color tuned separately for each mode:

```json
{
  "color": {
    "light": "oklch(0.55 0.20 250)",
    "dark": "oklch(0.70 0.18 250)"
  }
}
```

Hex with the dark variant derived automatically:

```json
{
  "color": {
    "light": "#059669"
  }
}
```

## Tips

* **Reach for system colors first.** They follow themes and modes for free; custom values only earn their keep when you need a brand shade the five names cannot express.
* **Build hierarchy with opacity.** `foreground/50` and `foreground/30` communicate "secondary" and "disabled" without adding new hues.
* **Check both modes.** Whenever you use custom colors — especially non-hex ones — flip between light and dark and confirm both read well.

## Troubleshooting

If a color does not show up as expected:

* The `color` field must sit at the top level of the entity entry, not nested inside another object.
* System names are lowercase and case-sensitive: `"accent"` works, `"Accent"` does not.
* A custom object needs at least a `light` value.
* Invalid system strings silently degrade to the default foreground color — double-check spelling and the opacity suffix.
