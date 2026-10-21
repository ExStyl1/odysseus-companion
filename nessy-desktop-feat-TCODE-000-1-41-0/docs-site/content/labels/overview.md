# Labels

Labels are colored tags you attach to sessions. Where a [status](../statuses/overview) is exclusive — every session has exactly one — labels are additive: a session can carry none, one, or many. They can nest into a tree, and they can optionally hold a typed value, which turns them into lightweight structured metadata (a ticket id, a due date, a priority number).

## How Labels Work

| Capability       | Detail                                                              |
| ---------------- | ------------------------------------------------------------------- |
| **Multi-select** | Any number of labels per session                                    |
| **Hierarchical** | Nested groups up to 5 levels deep                                   |
| **Color-coded**  | Shown as colored dots in lists and the sidebar                      |
| **Valued**       | Optional value with a `string`, `number`, `date`, or `link` type    |
| **Auto-applied** | Regex rules, or yes/no questions the decision model answers, tag sessions from message text — see [Auto-Apply Rules](./auto-rules) |

## Per-Workspace Configuration

Each workspace has its own label tree, stored at:

```
~/.nessy-agent/workspaces/<workspace-id>/labels/config.json
```

There are no built-in labels: a new workspace starts with an empty tree, and having no config file at all is a perfectly valid state.

## Creating Labels

::: tip
**Let the agent do it.** Describe the taxonomy you want:

- "Make a red Bug label"
- "Add Alpha and Beta project labels under an Engineering group"
- "Set up a Priority label that takes a number value"

The agent writes the config and validates it.
:::

For manual edits, the minimal config looks like this:

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

Nesting is expressed with a `children` array; a label's position in its array is its display order — there is no separate `order` field:

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

which the sidebar renders as:

```
Engineering
  ├─ Frontend
  │    └─ React
  └─ Backend
Bug
```

### Hierarchy Rules

- Ids are slugs: lowercase letters, digits, and hyphens, with no leading or trailing hyphen.
- Ids must be unique **across the whole tree**, not just among siblings.
- Nesting stops at **5 levels**.
- Array position controls ordering at every level.
- Filtering by a parent also matches sessions tagged with any of its descendants.

## Label Properties

| Property    | Type                                             | Required | Description                                                        |
| ----------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `id`        | string                                           | Yes      | Globally unique slug                                               |
| `name`      | string                                           | Yes      | Human-readable name                                                |
| `color`     | EntityColor                                      | No       | Dot color; falls back to the current text color when omitted       |
| `valueType` | `"string"` \| `"number"` \| `"date"` \| `"link"` | No       | Declares that the label carries a value; omit for presence-only    |
| `children`  | Label[]                                          | No       | Nested sub-labels                                                  |
| `autoRules` | AutoRule[]                                       | No       | Regex or semantic triggers, covered in [Auto-Apply Rules](./auto-rules) |

## Colors

`color` uses the same shared type as statuses:

- **System colors** carry semantic meaning and adapt to the theme automatically: `"destructive"` for bugs and incidents, `"accent"` for features, `"success"` for healthy things, `"info"` for metadata, `"foreground"` for neutral tags. All accept an opacity suffix, e.g. `"accent/80"` or `"foreground/60"`.
- **Custom pairs** give exact control: `{ "light": "#6366F1", "dark": "#818CF8" }`, in hex, OKLCH, RGB, or HSL. The `dark` value is optional and derived from `light` when missing.

A practical split: system colors for top-level categories, custom pairs where sub-labels need finer distinctions. Details on the palette live in [Colors](../customisation/colors).

## Label Values

Declaring a `valueType` turns a label into a key/value pair on the session — `priority` holding `3`, `due` holding a date, `ticket` holding an issue key.

### Storage Format

On a session, labels are a flat array of strings. A bare id is a presence-only label; an id followed by `::` carries a value:

```json
{
  "labels": ["bug", "priority::3", "due::2026-01-30", "ticket::NES-456"]
}
```

The split happens at the **first** `::` only, so values are free to contain `::` themselves (URLs, for instance).

Entries are kept in one form. A label with no `valueType` is stored as its bare id even when a rule or an edit supplied a value (`bug::bug` is stored as `bug`), and duplicates collapse: a plain label appears once, a valued label once per value, with letter case ignored in `string` values (`NES-1` and `nes-1` are one entry) and kept in links, numbers and dates. A session saved in an older form is cleaned when it loads. A label chip in the session header edits or removes only its own entry.

### Value Types

The type of a value is inferred from the raw string every time it is parsed:

| Inferred type | Rule                                                                | Example                          |
| ------------- | ------------------------------------------------------------------- | -------------------------------- |
| `date`        | `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` with a time                     | `"due::2026-01-30"`              |
| `number`      | Plain decimal, optional minus (`-?\d+(\.\d+)?`)                     | `"priority::3"`, `"effort::0.5"` |
| `string`      | Anything else                                                        | `"team::platform"`               |

Checks run in that order — date first, then number, then the string fallback. Date parsing round-trips the value, so an impossible date like `2026-02-29` is treated as a string rather than silently clamped. Hex, scientific notation, and similar exotic number formats deliberately stay strings.

The config-level `valueType` is a hint, not a cast: it tells the UI which input to offer and tells the agent what format to write, and malformed values (say `priority::high` on a `number` label) are rejected when session labels are resolved. `link` is a display affordance — the value is stored as an ordinary string, but the UI strips the scheme for a cleaner chip and offers to open it in the external browser (only `http`, `https`, and `mailto` links will open).

## Sidebar And Filtering

The label tree appears as an expandable section in the sidebar. Clicking a label narrows the session list to sessions carrying it; clicking a parent includes everything tagged with any label beneath it. If a label is deleted from the config, sessions that referenced it keep working — the dangling reference is simply filtered out of view.

## Validation

::: warning
Validate after hand-editing the config. Ill-formed regex in `autoRules` and structural mistakes are much cheaper to catch at save time.
:::

Labels are checked as part of the full config sweep:

```
config_validate({ target: "all" })
```

The label checks cover:

- JSON syntax and the recursive schema
- id uniqueness across the entire tree
- slug format for every id
- the 5-level depth limit
- every `autoRules` pattern (compile check plus a catastrophic-backtracking guard)

## Labels Versus Statuses

|                 | Labels                            | Statuses                          |
| --------------- | --------------------------------- | --------------------------------- |
| **Cardinality** | Many per session                  | Exactly one per session           |
| **Defaults**    | None — starts empty               | Five ship out of the box          |
| **Rendering**   | Colored dots                      | Icons plus colors                 |
| **Structure**   | Tree, up to 5 levels              | Flat, ordered list                |
| **Values**      | Optional typed values             | None                              |
| **Filtering**   | By label, descendants included    | By category (open/closed)         |
