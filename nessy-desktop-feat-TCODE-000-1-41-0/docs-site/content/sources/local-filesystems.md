# Local Filesystems

A local filesystem source is a named bookmark to a directory on your machine. It shows up in the sources list, carries its own documentation, and tells the agent where interesting files live without copying anything into the task folder.

::: info
There is no transport or server behind this source type. The agent reads the folder with the same `Read`, `Glob`, `Grep`, and `Bash` tools it uses on any path — the source adds a stable name, a description, and a guide.
:::

## When to Use a Local Folder

| Situation | Better fit |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Active work inside one project directory | [Working directory](../core-concepts/working-directory) |
| Several folders you reference across sessions | Local filesystem sources |
| A folder whose layout and rules need explaining | Local filesystem source plus a `guide.md` |

Rule of thumb: code in the working directory, everything else — notes, exports, sibling repos — as local folder sources.

## Configuration

A local source keeps its settings in `config.json`:

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
| -------------- | -------------------------------------------------------------------------- |
| `type` | Always `"local"` |
| `name` | Label shown in the sources list |
| `slug` | URL-safe identifier; doubles as the source folder name |
| `enabled` | Set `false` to deactivate without deleting |
| `provider` | Freeform label; `"local"` is the convention |
| `local.path` | Path to the directory; `~` expands to your home directory |
| `local.format` | Optional content hint, e.g. `"obsidian"`, `"git"`, `"sqlite"` |

Paths are stored in portable form (home-relative where possible), so a config survives a username or machine change. The `format` hint helps the agent pick the right approach for structured folders:

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

## Adding a Folder

Ask the agent:

> "Add my reports folder as a source"

Or create it by hand:

1. Make the source folder:
   ```
   ~/.nessy-agent/workspaces/{workspace-id}/sources/reports/
   ```
2. Write a `config.json` like the example above.
3. Optionally add a `guide.md` describing the contents.

Point the source at the narrowest directory that covers the task — a specific export folder beats a whole documents tree.

## guide.md Example

The guide tells the agent what the folder holds and how to treat it:

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

In Plan mode the agent can inspect local folders with the standard read-only command set (`ls`, `cat`, `head`, `tail`, and similar). To allow more commands, add them to the workspace's permissions (**Settings → Permissions**, or the workspace `permissions.json`). A shell pattern applies to the whole session, not to one folder, so a source's own `permissions.json` ignores it:

```json
{
  "allowedBashPatterns": [
    { "pattern": "^tree\\s", "comment": "Directory tree listings" },
    { "pattern": "^wc\\s", "comment": "Line and word counts" }
  ]
}
```

Rules are additive on top of the defaults. See [permissions](../core-concepts/permissions) for how modes interact with sources.

## Local Folders vs Working Directory

- **Working directory** — the project you are actively building in. Set per session, full tool access, the natural home for code, builds, and tests.
- **Local folder source** — a documented bookmark for material you consult: a notes vault, a directory of exports, a sibling repository used for comparison.

## Safety Notes

Avoid registering your entire home directory. When a task needs one file, add its smallest useful parent folder, keep the session in a conservative [permission mode](../core-concepts/permissions) until the agent has looked around, and disable the source again when the task is done.
