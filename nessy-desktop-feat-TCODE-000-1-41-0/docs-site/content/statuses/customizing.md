# Customizing Statuses

Workspace statuses are plain JSON, so you can reshape the workflow to match how your team actually reviews work.

::: tip
**Let the agent do it.** Describing the change is usually enough:

- "Add a red Blocked status to this workspace"
- "Create a Waiting state for sessions that are on hold"
- "Insert an In Progress status between Todo and Needs Review"

The agent edits the config, keeps the ordering consistent, and validates the result.
:::

For manual edits, everything below documents the file format.

## Configuration File

Each workspace keeps its own status config at:

```
~/.nessy-agent/workspaces/<workspace-id>/statuses/config.json
```

## Config Schema

```json
{
  "version": 1,
  "statuses": [
    {
      "id": "todo",
      "label": "Todo",
      "category": "open",
      "isFixed": true,
      "isDefault": false,
      "order": 1
    }
  ],
  "defaultStatusId": "todo"
}
```

`version` is the schema version (currently `1`), `statuses` holds the full list of states, and `defaultStatusId` names the status assigned to newly created sessions.

## Status Properties

| Property    | Type                   | Required | Description                                              |
| ----------- | ---------------------- | -------- | -------------------------------------------------------- |
| `id`        | string                 | Yes      | Stable identifier, lowercase alphanumeric with hyphens   |
| `label`     | string                 | Yes      | Text displayed in menus and lists                        |
| `category`  | `"open"` \| `"closed"` | Yes      | Inbox placement vs archive placement                     |
| `isFixed`   | boolean                | Yes      | `true` blocks deletion and renaming                      |
| `isDefault` | boolean                | Yes      | `true` blocks deletion but allows edits                  |
| `order`     | number                 | Yes      | Sort position in menus and lists (lower shows first)     |
| `color`     | EntityColor            | No       | System color name or custom light/dark pair (see below)  |
| `icon`      | string                 | No       | Emoji, URL, or a filename inside `statuses/icons/`       |

::: info
Omitting `color` applies the built-in palette: `needs-review` renders with the info color, `done` with the accent color, and `backlog`, `todo`, and `cancelled` with a muted foreground tone. Omitting `icon` triggers auto-discovery of `statuses/icons/<id>.<ext>` (`.svg`, `.png`, `.jpg`, `.jpeg`).
:::

## Adding A Custom Status

Append an object to the `statuses` array and pick an `order` that slots it where you want:

```json
{
  "id": "blocked",
  "label": "Blocked",
  "color": { "light": "#DC2626", "dark": "#F87171" },
  "icon": "🚫",
  "category": "open",
  "isFixed": false,
  "isDefault": false,
  "order": 2
}
```

Renumber neighbouring entries if the new state should sit between existing ones. And rename with care: session records and [automation](../automations/overview) matchers reference the `id`, so changing an id mid-flight is effectively deleting one status and creating another.

### Example: A Fuller Workflow

```json
{
  "version": 1,
  "statuses": [
    { "id": "backlog", "label": "Backlog", "category": "open", "isFixed": false, "isDefault": true, "order": 0 },
    { "id": "todo", "label": "Todo", "category": "open", "isFixed": true, "isDefault": false, "order": 1 },
    { "id": "in-progress", "label": "In Progress", "category": "open", "isFixed": false, "isDefault": false, "order": 2 },
    { "id": "blocked", "label": "Blocked", "icon": "🚫", "category": "open", "isFixed": false, "isDefault": false, "order": 3 },
    { "id": "needs-review", "label": "Needs Review", "category": "open", "isFixed": false, "isDefault": true, "order": 4 },
    { "id": "done", "label": "Done", "category": "closed", "isFixed": true, "isDefault": false, "order": 5 },
    { "id": "cancelled", "label": "Cancelled", "category": "closed", "isFixed": true, "isDefault": false, "order": 6 }
  ],
  "defaultStatusId": "todo"
}
```

The `in-progress` entry above needs no `icon` value: the app pre-seeds `statuses/icons/` with a ready-made `in-progress.svg` alongside the default five, so the icon is picked up automatically.

## Icons

An icon can be supplied four ways, resolved in this priority order:

1. **Explicit local filename** — `"icon": "review.svg"` loads `statuses/icons/review.svg`.
2. **Auto-discovered file** — with `icon` omitted, the app looks for `statuses/icons/<id>.<ext>`. This is the recommended route for custom SVGs: drop the file in, no config change needed.
3. **URL** — `"icon": "https://example.com/flag.svg"` is downloaded once and cached as `statuses/icons/<id>.<ext>`.
4. **Emoji** — `"icon": "🔥"` renders as text.

### SVG Guidelines

To blend in with the bundled icon set, draw custom SVGs on a 24×24 viewBox, use `currentColor` for stroke or fill so they follow the theme, and stick to `stroke-width="2"` with round line caps and joins. See [Icons](../customisation/icons) for general icon advice.

## Colors

The `color` property accepts either form of the shared color type:

- **System colors** — `"accent"`, `"info"`, `"success"`, `"destructive"`, `"foreground"`, optionally with an opacity suffix from 0–100: `"foreground/50"`, `"info/80"`. These map to theme variables and adapt to light/dark mode on their own.
- **Custom pairs** — `{ "light": "#DC2626", "dark": "#F87171" }` in hex, OKLCH, RGB, or HSL. If `dark` is omitted, a lighter variant is derived automatically.

Configs written by very old versions may still contain Tailwind class strings like `"text-red-500"`; they are migrated to the current format the first time the workspace loads. See [Colors](../customisation/colors) for the palette behind the system names.

## Fixed Statuses

Three ids can never be removed or renamed because core behavior depends on them:

| ID          | Why it must exist                                    |
| ----------- | ---------------------------------------------------- |
| `todo`      | Fallback and usual default for new sessions          |
| `done`      | The canonical "finished" closed state                |
| `cancelled` | The canonical "abandoned" closed state               |

Their `color` and `icon` remain fully customizable.

## Validation

::: warning
Validate after every manual edit — a config that fails validation is ignored and the workspace reverts to the default statuses at runtime.
:::

Ask the agent to run:

```
config_validate({ target: "statuses" })
```

The validator enforces:

- schema correctness (field types, id format, non-negative integer `order`)
- presence of the required fixed statuses `todo`, `done`, `cancelled`
- no duplicate status ids
- `defaultStatusId` pointing at a status that exists
- at least one `open` status (error) and at least one `closed` status (warning)
- `isFixed: true` on the three required ids (warning if unset)
