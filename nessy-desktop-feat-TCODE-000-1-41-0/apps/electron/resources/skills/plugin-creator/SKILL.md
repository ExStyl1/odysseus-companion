---
name: Plugin Creator
description: Guide for creating a new Nessy plugin bundle. Use when the user wants to author, scaffold, or package a plugin — interview them, write a plugin.json manifest plus its component files, then install it locally through the existing plugin install flow.
---

# Plugin Creator

Use this skill when the user asks to create, author, scaffold, or package a
plugin. A plugin bundles one or more capabilities — skills, prompt commands,
MCP servers, hooks — behind a single manifest so they install and enable
together. Follow the steps in order; do not skip the interview.

## What a plugin is

A plugin is a folder containing a manifest that describes the bundle, plus the
component files it ships:

```
<plugin-folder>/
  plugin.json     # required: the bundle manifest
  skills/...      # optional: bundled skill folders (SKILL.md each)
  ...             # optional: prompt-command markdown, MCP config, etc.
```

The native manifest filename is `plugin.json`. The legacy filename
`nessy-extension.json` is also accepted; prefer `plugin.json` for new plugins.
Scaffold the bundle into a folder under `~/.nessy-agent/` through your normal
file-writing tool so the write goes through the usual approval.

## Step 1 — Interview the user first

Do not invent a purpose the user did not ask for. Ground the plugin in a real
need by asking:

- **What should the plugin bundle?** Skills, prompt commands, MCP servers,
  hooks, or a mix.
- **When and how is it used?** The workflow it supports.
- **What configuration does it require?** Any settings, commands, or endpoints
  its components need.

Ask clarifying questions before writing anything. Keep the bundle minimal —
include only the components the plugin genuinely needs.

## Step 2 — Write the manifest

Choose a short, lowercase, hyphenated plugin id (for example `team-workflow`).
The manifest requires these fields:

- `id` — the lowercase, hyphenated plugin id.
- `name` — a human-readable display name.
- `version` — a semantic version string (for example `"1.0.0"`).
- `capabilities` — an array of capability entries. Each entry has an `id` and a
  `kind`, plus a kind-specific descriptor.

Supported capability `kind` values include `skill`, `mcp`, `hook`,
`prompt-command`, `setting`, `command`, and `asset`.

Example `plugin.json` bundling one skill and one MCP server:

```json
{
  "id": "team-workflow",
  "name": "Team Workflow",
  "version": "1.0.0",
  "description": "Team conventions and a linting MCP server.",
  "capabilities": [
    {
      "id": "skill.commit-style",
      "kind": "skill",
      "displayName": "Commit Style",
      "skill": { "slug": "commit-style", "path": "skills/commit-style" }
    },
    {
      "id": "mcp.linter",
      "kind": "mcp",
      "displayName": "Linter",
      "mcp": {
        "serverName": "linter",
        "transport": "stdio",
        "command": "team-linter",
        "args": ["--stdio"]
      }
    }
  ]
}
```

Ship each declared component alongside the manifest. A bundled skill is a folder
at the capability's `path` (relative to the plugin root) containing its own
`SKILL.md` with `name`/`description` frontmatter — the same skill format the
skill-creator skill covers. Do not put credentials, tokens, or filesystem roots
in `setting` capabilities; the manifest validator rejects those keys.

## Step 3 — Install locally

Once the bundle is scaffolded, install it **through the existing plugin install
flow** — the same local-folder / repository install the app's "Add plugin" flow
uses. Do not build a new install mechanism. The install validates the manifest
and its capabilities, so fix anything it reports and reinstall until it succeeds.

## Step 4 — Confirm

Tell the user clearly that the plugin was created and installed, where the bundle
lives, and which capabilities it now provides. Mention they can enable or disable
its capabilities from the Plugins page.
