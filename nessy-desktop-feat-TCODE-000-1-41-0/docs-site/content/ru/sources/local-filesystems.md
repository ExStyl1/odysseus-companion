# Локальные файловые системы

Local filesystem source — named bookmark к directory на вашей машине. Он появляется в sources list, несёт собственную documentation и говорит агенту, где лежат интересные files, ничего не копируя в task folder.

::: info
За этим source type нет transport или server. Агент читает folder теми же tools `Read`, `Glob`, `Grep` и `Bash`, которые использует на любом path — source добавляет stable name, description и guide.
:::

## Когда использовать local folder

| Situation | Better fit |
| --------- | ---------- |
| Active work inside one project directory | [Working directory](../core-concepts/working-directory) |
| Several folders you reference across sessions | Local filesystem sources |
| A folder whose layout and rules need explaining | Local filesystem source plus a `guide.md` |

Rule of thumb: code — в working directory, всё остальное — notes, exports, sibling repos — как local folder sources.

## Configuration

Local source хранит settings в `config.json`:

```json
{
  "id": "my-notes_9f8e7d6c",
  "type": "local",
  "name": "My Notes",
  "slug": "my-notes",
  "enabled": true,
  "provider": "local",
  "local": {
    "path": "~/Documents/Notes"
  }
}
```

### Field Reference

| Field | Description |
| ----- | ----------- |
| `type` | Всегда `"local"` |
| `name` | Label, показанный в sources list |
| `slug` | URL-safe identifier; также source folder name |
| `enabled` | Задайте `false`, чтобы deactivate без удаления |
| `provider` | Freeform label; `"local"` — convention |
| `local.path` | Path к directory; `~` expands to your home directory |
| `local.format` | Optional content hint, например `"obsidian"`, `"git"`, `"sqlite"` |

Paths сохраняются в portable form (home-relative where possible), поэтому config переживает смену username или machine. Hint `format` помогает агенту выбрать правильный подход к structured folders:

```json
{
  "type": "local",
  "name": "Obsidian Vault",
  "slug": "vault",
  "provider": "obsidian",
  "local": {
    "path": "~/Documents/Vault",
    "format": "obsidian"
  }
}
```

## Добавление folder

Попросите агента:

> "Add my reports folder as a source"

Или создайте вручную:

1. Make the source folder:
   ```
   ~/.nessy-agent/workspaces/{workspace-id}/sources/reports/
   ```
2. Write a `config.json` like the example above.
3. Optionally add a `guide.md` describing the contents.

Направляйте source на самую узкую directory, покрывающую задачу — specific export folder лучше whole documents tree.

## guide.md Example

Guide объясняет агенту, что лежит в folder и как с этим обращаться:

```markdown
# Reports

Monthly CSV and PDF exports from the billing system.

## Scope

Read-only reference data. Files are named YYYY-MM-<system>.csv.

## Guidelines

- Newest files are authoritative; older ones may be superseded
- Never edit exports in place — copy into the working directory first
- Ignore the /archive subfolder unless asked
```

## Plan Mode Permissions

В Plan mode агент может inspect local folders стандартным read-only command set (`ls`, `cat`, `head`, `tail` и similar). Чтобы разрешить больше команд, добавьте их в permissions workspace (**Settings → Permissions** или `permissions.json` workspace). Shell pattern действует на всю session, а не на одну папку, поэтому собственный `permissions.json` источника его игнорирует:

```json
{
  "allowedBashPatterns": [
    { "pattern": "^tree\\s", "comment": "Directory tree listings" },
    { "pattern": "^wc\\s", "comment": "Line and word counts" }
  ]
}
```

Rules additive поверх defaults. См. [permissions](../core-concepts/permissions), чтобы понять, как modes взаимодействуют с sources.

## Local Folders vs Working Directory

- **Working directory** — project, который вы actively building in. Задаётся per session, даёт full tool access и естественно подходит для code, builds и tests.
- **Local folder source** — documented bookmark для материалов, к которым вы обращаетесь: notes vault, directory exports, sibling repository для comparison.

## Safety Notes

Не регистрируйте entire home directory. Когда task нужен один file, добавьте smallest useful parent folder, держите session в conservative [permission mode](../core-concepts/permissions), пока агент осмотрится, и снова disable source, когда task завершена.
