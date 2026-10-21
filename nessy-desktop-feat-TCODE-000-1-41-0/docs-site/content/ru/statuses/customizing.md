# Настройка статусов

Workspace statuses — plain JSON, поэтому workflow можно подстроить под реальный review process вашей команды.

::: tip
**Let the agent do it.** Обычно достаточно описать change:

- "Add a red Blocked status to this workspace"
- "Create a Waiting state for sessions that are on hold"
- "Insert an In Progress status between Todo and Needs Review"

Агент отредактирует config, сохранит ordering consistent и validate result.
:::

Для manual edits ниже описан file format.

## Configuration File

Каждая workspace хранит свой status config at:

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

`version` — schema version (currently `1`), `statuses` содержит full list states, а `defaultStatusId` names status assigned to newly created sessions.

## Status Properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `id` | string | Yes | Stable identifier, lowercase alphanumeric with hyphens |
| `label` | string | Yes | Text displayed in menus and lists |
| `category` | `"open"` \| `"closed"` | Yes | Inbox placement vs archive placement |
| `isFixed` | boolean | Yes | `true` blocks deletion and renaming |
| `isDefault` | boolean | Yes | `true` blocks deletion but allows edits |
| `order` | number | Yes | Sort position in menus and lists (lower shows first) |
| `color` | EntityColor | No | System color name или custom light/dark pair (см. below) |
| `icon` | string | No | Emoji, URL или filename inside `statuses/icons/` |

::: info
Если `color` omitted, применяется built-in palette: `needs-review` renders with info color, `done` with accent color, а `backlog`, `todo` и `cancelled` with muted foreground tone. Если `icon` omitted, запускается auto-discovery `statuses/icons/<id>.<ext>` (`.svg`, `.png`, `.jpg`, `.jpeg`).
:::

## Adding A Custom Status

Append object to `statuses` array и выберите `order`, который ставит его в нужное место:

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

Renumber neighbouring entries, если new state должен стоять между existing ones. Переименовывайте осторожно: session records и [automation](../automations/overview) matchers reference `id`, поэтому changing id mid-flight effectively deletes one status and creates another.

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

Entry `in-progress` выше не требует `icon`: app pre-seeds `statuses/icons/` ready-made `in-progress.svg` alongside default five, поэтому icon picked up automatically.

## Icons

Icon можно задать четырьмя способами, resolved in priority order:

1. **Explicit local filename** — `"icon": "review.svg"` loads `statuses/icons/review.svg`.
2. **Auto-discovered file** — когда `icon` omitted, app ищет `statuses/icons/<id>.<ext>`. Recommended route для custom SVGs: drop file in, no config change needed.
3. **URL** — `"icon": "https://example.com/flag.svg"` downloads once and cached as `statuses/icons/<id>.<ext>`.
4. **Emoji** — `"icon": "🔥"` renders as text.

### SVG Guidelines

Чтобы blend in with bundled icon set, рисуйте custom SVGs на 24×24 viewBox, используйте `currentColor` для stroke или fill, чтобы они follow theme, и держите `stroke-width="2"` with round line caps and joins. См. [Icons](../customisation/icons) для general icon advice.

## Colors

Property `color` принимает любую форму shared color type:

- **System colors** — `"accent"`, `"info"`, `"success"`, `"destructive"`, `"foreground"`, optional opacity suffix 0–100: `"foreground/50"`, `"info/80"`. Они map to theme variables и сами adapt to light/dark mode.
- **Custom pairs** — `{ "light": "#DC2626", "dark": "#F87171" }` в hex, OKLCH, RGB или HSL. Если `dark` omitted, lighter variant derived automatically.

Configs from very old versions may still contain Tailwind class strings like `"text-red-500"`; они migrate to current format first time workspace loads. См. [Colors](../customisation/colors) for palette behind system names.

## Fixed Statuses

Три ids нельзя remove or rename, потому что core behavior depends on them:

| ID | Why it must exist |
| --- | --- |
| `todo` | Fallback and usual default for new sessions |
| `done` | The canonical "finished" closed state |
| `cancelled` | The canonical "abandoned" closed state |

Их `color` и `icon` fully customizable.

## Validation

::: warning
Validate after every manual edit — config, failing validation, ignored, and workspace reverts to default statuses at runtime.
:::

Ask the agent to run:

```
config_validate({ target: "statuses" })
```

Validator enforces:

- schema correctness (field types, id format, non-negative integer `order`)
- presence of required fixed statuses `todo`, `done`, `cancelled`
- no duplicate status ids
- `defaultStatusId` pointing at status that exists
- at least one `open` status (error) and at least one `closed` status (warning)
- `isFixed: true` on three required ids (warning if unset)
