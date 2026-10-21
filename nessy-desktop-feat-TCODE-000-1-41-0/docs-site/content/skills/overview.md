# Skills

Skills are reusable instruction folders that teach the agent a repeatable job. Each skill is a directory containing a `SKILL.md` file — YAML frontmatter that describes the skill plus a markdown body the agent follows when the skill runs. Invoke a skill by `@`-mentioning it in the composer, run it as its own `/slug` slash command, or let the agent pick it up on its own when the description fits the task.

The file layout matches the `SKILL.md` convention used by Claude Code and other agent tooling, so a skill folder written for one tool usually works in the others.

## Creating Skills

The fastest path is to describe the skill you want and let the agent write it:

```
Create a skill called "commit" that writes conventional commit messages
```

The agent knows the storage layout and the frontmatter schema, so it can scaffold the folder, fill in the metadata, and iterate on the instructions with you. You can also create the folder by hand — a skill is just files on disk.

For a guided flow, run **/create-skill** in the composer (or use the **Add Skill** action). It opens a visible chat driven by the built-in **Skill Creator** guide, which interviews you, scaffolds a valid `SKILL.md`, and validates it. Skill Creator and Plugin Creator ship with the app and are seeded into your skills on first run — seeded only when missing, so a skill you have edited is never overwritten.

## Skill Anatomy

A Workspace skill lives under the managed Workspace resource directory.
`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`:

```
CONFIG_DIR/workspaces/<workspace-id>/skills/<slug>/
├── SKILL.md      # Required — frontmatter + instructions
└── icon.png      # Optional — cached automatically when icon is a URL
```

The folder name is the skill's slug (lowercase alphanumeric with hyphens). Extra files — scripts, templates, reference material — can sit alongside `SKILL.md` and be referenced from the instructions.

### SKILL.md Format

```markdown
---
name: Commit
description: Write conventional commit messages from the staged diff
icon: 🔧
allowed-tools:
  - Bash(git status)
  - Bash(git diff)
paths:
  - "**/.git/**"
requiredSources:
  - issue-tracker
---

When asked to commit:
- Use conventional prefixes (feat:, fix:, docs:, refactor:)
- Keep the subject line under 72 characters
- Explain the reason for the change, not the mechanics
```

Everything above the second `---` is metadata; everything below it is the instruction body handed to the agent at invocation time.

### Frontmatter Fields

| Field             | Required | Description                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------ |
| `name`            | No       | Human-readable display name; defaults to the folder name                       |
| `description`     | Recommended | Short summary shown in the skill picker; also how the agent decides relevance. Falls back to the first paragraph of the body |
| `when_to_use`     | No       | Extra trigger context (phrases, example requests) appended to the description in the listing |
| `icon`            | No       | An emoji (`🔧`) or an icon URL. Relative paths and inline SVG are rejected.    |
| `arguments`       | No       | Named positional arguments for `$name` substitution — a space-separated string or a YAML list; the order is the position mapping |
| `argument-hint`   | No       | Autocomplete hint for expected arguments, e.g. `[issue-number]`                |
| `allowed-tools`   | No       | Tools pre-approved for the invoking turn — they skip the approval prompt. It does not restrict anything: every other tool stays callable under your normal permission rules |
| `disallowed-tools`| No       | Tools removed from the pool while the skill is active — this is the field that restricts |
| `disable-model-invocation` | No | `true` blocks the model from invoking the skill and keeps it out of the listing; you can still invoke it yourself. Default `false` |
| `user-invocable`  | No       | `false` hides the skill from the `/` menu; the model can still invoke it. Default `true` |
| `model`           | No       | Model override while the skill is active                                       |
| `effort`          | No       | Effort level override: `low`, `medium`, `high`, `xhigh`, or `max`; an unrecognized value is ignored |
| `paths`           | No       | Glob patterns that gate *automatic* activation to matching files; your own invocation is never gated. `globs` is accepted as a legacy alias |
| `alwaysAllow`     | No       | Tool patterns pre-approved while the skill runs (e.g. `["Bash(bun test)"]`)    |
| `requiredSources` | No       | Slugs of sources that get enabled automatically whenever the skill runs        |

The hyphenated spellings above follow the shared `SKILL.md` convention; the camelCase spelling of each field (`allowedTools`, `userInvocable`, …) is accepted too.

`allowed-tools` and `disallowed-tools` are read the same way as an agent's [tool patterns](../go-further/workspaces#tool-patterns): a YAML list, or one string whose entries are separated by spaces or commas, with a comma **inside** parentheses belonging to its entry — `Agent(reviewer, planner)` is one entry, not two. The frontmatter is parsed as YAML throughout, so a list written inline (`paths: [src/**, docs/**]`) means exactly what the block form means.

Parsing is deliberately lenient: a missing `name` falls back to the folder name, a missing `description` falls back to the first paragraph of the body, and malformed YAML loads the body with empty metadata instead of dropping the skill. Declare both fields anyway — they drive the picker and automatic selection, and the `skill_validate` tool flags their absence.

::: info
`requiredSources` removes the "agent discovers a missing tool one turn too late" problem: when the skill is invoked, each listed source is enabled for the session before the first turn. A source that is not configured in the workspace, or not yet authenticated, is skipped and handled at runtime instead. See [Sources](../sources/overview) for setup.
:::

::: tip
When `icon` is a URL, the file is downloaded once and cached as `icon.<ext>` inside the skill folder. You can also just drop an `icon.svg`, `icon.png`, or `icon.jpg` file into the folder — it is auto-discovered without any frontmatter.
:::

## Using Skills

A skill can be invoked three ways:

- **Mention it.** Type `@` in the message box and pick the skill from the menu, or keep typing to filter by slug:

  ```
  @commit
  @review the authentication changes
  @release-notes for the last sprint
  ```

- **Run it as a slash command.** Every skill also registers as `/slug` (unless its frontmatter sets `user-invocable: false`); text after the command becomes the skill's arguments.

- **Let the agent pick it.** The model invokes a skill on its own when the description and `when_to_use` fit the task — unless `disable-model-invocation: true`, and, when `paths` is set, only while working with matching files.

The mention is stored in the message as a `[skill:slug]` token, and the skill's instructions are handed to the agent for that turn. Tools listed in `allowed-tools` or `alwaysAllow` skip the approval prompt while the skill is active — everything else still follows your normal [permission rules](../core-concepts/permissions). `allowed-tools` is only a pre-approval: it never takes a tool away, and the grant ends with the turn that invoked the skill. To keep a skill away from a tool, list it in `disallowed-tools`, which removes it from the pool for that turn.

### Arguments

Text typed after the invocation is available inside the skill body through substitution tokens:

| Token | Expands to |
| --- | --- |
| `$ARGUMENTS` | The full argument string as typed |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, … | Individual arguments, 0-based |
| `$0`, `$1`, … | Shorthand for the indexed form |
| `$name` | A named argument declared in the `arguments` frontmatter list |

A skill that declares `arguments: issue format` can write `Fix issue $issue and output $format` and be called as `/fix-issue 123 markdown`.

## Skill Locations

| Scope | Path | Ownership |
| --- | --- | --- |
| Nessy-managed global | `CONFIG_DIR/skills/<slug>/` | Nessy v2 state |
| Shared personal | `~/.agents/skills/<slug>/` | External; Nessy never rewrites it |
| Workspace | `CONFIG_DIR/workspaces/<workspace-id>/skills/<slug>/` | Nessy Workspace resource |
| Project | `<working-directory>/.agents/skills/<slug>/` | External repository content |

After bundle/native defaults, policy precedence is global, Workspace, trusted
active-repository policy, private `(workspaceId, ProjectKey)` override, then
session selection. A terminal suppression stays terminal. The private override
is Nessy-managed state and is never written into the repository. Nessy discovers
Project `.agents/skills` from the active [working
directory](../core-concepts/working-directory) up through the Project root, and
loads them only after the backend revalidates the Project identity and
whole-project trust is granted.
External Projects and `~/.agents` stay untouched during storage cutover and are
not included in a `CONFIG_DIR` backup.

Skills with the same slug are not discarded. Each remains addressable by a
qualified ID; legacy unqualified mentions use the deterministic nearest-scope,
native-first alias and surface a collision diagnostic rather than depending on
filesystem order.

## Plugin-Provided Skills

[Plugins](../plugins/overview) can also contribute skills. Plugin skills are
projected from the immutable, content-hashed installed bundle as read-only
runtime capabilities, so editable skill folders remain under the locations
above.

If a plugin skill uses the same slug as a native Project, Workspace, or global
skill, both qualified capabilities remain available and the unqualified alias
prefers native at the nearest scope. Manage the plugin through the plugin
runtime or Plugins page rather than editing its cache.

## Validating Skills

After writing or editing a skill, ask the agent to run its `skill_validate` tool on the slug. It checks that:

- the slug is a valid lowercase-alphanumeric-with-hyphens name
- `SKILL.md` exists and is readable
- the frontmatter parses and contains `name` and `description` (the loader tolerates their absence, but the validator wants them declared)
- field values are well-formed — for example `effort` is one of its allowed levels
- unknown frontmatter keys produce a warning, never an error, so a skill written for a newer client still loads
- the body is not empty
- the icon, if present, is an emoji, URL, or supported image format

## Good Skill Design

- Lead the `description` with *when* to use the skill, not just what it does — that text drives automatic selection.
- Keep instructions operational and testable: concrete steps, checks, and output expectations beat abstract advice.
- Put large examples in separate files inside the skill folder so the main guidance stays readable.
- Prefer several small, single-purpose skills over one sprawling one; slugs are cheap.
