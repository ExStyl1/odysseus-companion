# Labels

Labels — цветные tags, которые вы прикрепляете к sessions. Если [status](../statuses/overview) exclusive — у каждой session ровно один — labels additive: session может иметь ни одного, один или много. Они могут складываться в tree и optionally хранить typed value, превращаясь в lightweight structured metadata: ticket id, due date, priority number.

## How Labels Work

| Capability | Detail |
| ---------- | ------ |
| **Multi-select** | Any number of labels per session |
| **Hierarchical** | Nested groups up to 5 levels deep |
| **Color-coded** | Shown as colored dots in lists and sidebar |
| **Valued** | Optional value with `string`, `number`, `date` или `link` type |
| **Auto-applied** | Regex-правила или вопросы «да/нет», на которые отвечает модель решений, ставят метки по тексту сообщений — см. [Auto-Apply Rules](./auto-rules) |

## Per-Workspace Configuration

Каждая workspace имеет свой label tree, stored at:

```
~/.nessy-agent/workspaces/<workspace-id>/labels/config.json
```

Built-in labels нет: new workspace starts with empty tree, and no config file at all is a valid state.

## Creating Labels

::: tip
**Let the agent do it.** Опишите taxonomy:

- "Make a red Bug label"
- "Add Alpha and Beta project labels under an Engineering group"
- "Set up a Priority label that takes a number value"

Агент напишет config и validate it.
:::

Для manual edits minimal config:

```json
{
  "version": 1,
  "labels": [
    { "id": "bug", "name": "Bug", "color": "destructive" },
    { "id": "feature", "name": "Feature", "color": "accent" }
  ]
}
```

## Hierarchical Labels

Nesting задаётся через array `children`; позиция label в array — display order, separate `order` field нет:

```json
{
  "version": 1,
  "labels": [
    {
      "id": "eng",
      "name": "Engineering",
      "color": "info",
      "children": [
        {
          "id": "frontend",
          "name": "Frontend",
          "children": [
            { "id": "react", "name": "React", "color": { "light": "#2563EB", "dark": "#60A5FA" } }
          ]
        },
        { "id": "backend", "name": "Backend" }
      ]
    },
    { "id": "bug", "name": "Bug", "color": "destructive" }
  ]
}
```

which sidebar renders as:

```
Engineering
  ├─ Frontend
  │    └─ React
  └─ Backend
Bug
```

### Hierarchy Rules

- Ids are slugs: lowercase letters, digits and hyphens, no leading/trailing hyphen.
- Ids must be unique **across whole tree**, not just among siblings.
- Nesting stops at **5 levels**.
- Array position controls ordering at every level.
- Filtering by parent also matches sessions tagged with any descendants.

## Label Properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `id` | string | Yes | Globally unique slug |
| `name` | string | Yes | Human-readable name |
| `color` | EntityColor | No | Dot color; fallback to current text color when omitted |
| `valueType` | `"string"` \| `"number"` \| `"date"` \| `"link"` | No | Declares that label carries a value; omit for presence-only |
| `children` | Label[] | No | Nested sub-labels |
| `autoRules` | AutoRule[] | No | Regex- или семантические триггеры, описаны в [Auto-Apply Rules](./auto-rules) |

## Colors

`color` uses same shared type as statuses:

- **System colors** carry semantic meaning and adapt to theme automatically: `"destructive"` for bugs/incidents, `"accent"` for features, `"success"` for healthy things, `"info"` for metadata, `"foreground"` for neutral tags. Все accept opacity suffix, e.g. `"accent/80"` or `"foreground/60"`.
- **Custom pairs** give exact control: `{ "light": "#6366F1", "dark": "#818CF8" }`, in hex, OKLCH, RGB or HSL. `dark` optional and derived from `light` when missing.

Practical split: system colors for top-level categories, custom pairs where sub-labels need finer distinctions. Details on palette live in [Colors](../customisation/colors).

## Label Values

Declaring `valueType` turns label into key/value pair on session — `priority` holding `3`, `due` holding date, `ticket` holding issue key.

### Storage Format

On session, labels are flat array of strings. Bare id is presence-only label; id followed by `::` carries value:

```json
{
  "labels": ["bug", "priority::3", "due::2026-01-30", "ticket::NES-456"]
}
```

Split happens at the **first** `::` only, so values can contain `::` themselves (URLs, for instance).

Записи хранятся в одной форме. Метка без `valueType` хранится как голый id, даже если правило или правка дали ей значение (`bug::bug` хранится как `bug`), а повторы схлопываются: простая метка встречается один раз, метка со значением — один раз на значение, причём регистр букв не различается в значениях `string` (`NES-1` и `nes-1` — одна запись) и различается в ссылках, числах и датах. Сессия, сохранённая в старой форме, очищается при загрузке. Чип метки в заголовке сессии правит или удаляет только свою запись.

### Value Types

Type value inferred from raw string every time it is parsed:

| Inferred type | Rule | Example |
| ------------- | ---- | ------- |
| `date` | `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` with time | `"due::2026-01-30"` |
| `number` | Plain decimal, optional minus (`-?\d+(\.\d+)?`) | `"priority::3"`, `"effort::0.5"` |
| `string` | Anything else | `"team::platform"` |

Checks run in that order — date first, then number, then string fallback. Date parsing round-trips value, so impossible date like `2026-02-29` treated as string rather than silently clamped. Hex, scientific notation and similar exotic number formats deliberately stay strings.

Config-level `valueType` — hint, not cast: it tells UI which input to offer and agent what format to write, and malformed values (say `priority::high` on `number` label) rejected when session labels resolved. `link` is display affordance — value stored as ordinary string, but UI strips scheme for cleaner chip and offers to open it in external browser (only `http`, `https` and `mailto` links open).

## Sidebar And Filtering

Label tree appears as expandable section in sidebar. Click label to narrow session list to sessions carrying it; click parent includes everything tagged by any label below it. If label deleted from config, sessions referencing it keep working — dangling reference simply filtered out of view.

## Validation

::: warning
Validate after hand-editing config. Ill-formed regex in `autoRules` and structural mistakes are much cheaper to catch at save time.
:::

Labels checked as part of full config sweep:

```
config_validate({ target: "all" })
```

Label checks cover:

- JSON syntax and recursive schema
- id uniqueness across entire tree
- slug format for every id
- 5-level depth limit
- every `autoRules` pattern (compile check plus catastrophic-backtracking guard)

## Labels Versus Statuses

| | Labels | Statuses |
| --- | --- | --- |
| **Cardinality** | Many per session | Exactly one per session |
| **Defaults** | None — starts empty | Five ship out of the box |
| **Rendering** | Colored dots | Icons plus colors |
| **Structure** | Tree, up to 5 levels | Flat, ordered list |
| **Values** | Optional typed values | None |
| **Filtering** | By label, descendants included | By category (open/closed) |
