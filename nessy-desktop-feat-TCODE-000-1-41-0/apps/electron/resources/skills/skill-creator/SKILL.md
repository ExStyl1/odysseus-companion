---
name: Skill Creator
description: Guide for creating a new Nessy skill. Use when the user wants to author, scaffold, or add a skill — interview them, then write a SKILL.md with valid frontmatter into the global skills directory and validate it with skill_validate.
---

# Skill Creator

Use this skill when the user asks to create, author, scaffold, or add a new
skill. It walks you through interviewing the user, writing a well-formed
`SKILL.md`, and validating it. Follow the steps in order; do not skip the
interview.

## What a skill is

A skill is a folder of reusable instructions the agent loads when it is relevant
to the task at hand. On disk a skill is a directory that contains a `SKILL.md`
file:

```
~/.nessy-agent/skills/<slug>/
  SKILL.md        # required: frontmatter + markdown instructions
  icon.svg        # optional: icon shown in the UI
  <other files>   # optional: supporting reference material
```

The full format reference lives in `~/.nessy-agent/docs/skills.md` — consult it
when you need detail on optional frontmatter fields.

## Step 1 — Interview the user first

Do not invent a purpose the user did not ask for. Ground the skill in a real
need by asking:

- **What should the skill do?** The concrete task or domain it covers.
- **When should it trigger?** The `description` is what the agent matches on, so
  it must be specific and action-oriented — not a vague topic label.
- **What instructions or examples make it useful?** The steps, conventions, and
  boundaries the agent should follow.

Ask clarifying questions before writing anything. Keep each skill focused on one
task or domain; if the user describes several unrelated jobs, suggest separate
skills.

## Step 2 — Choose a slug

Pick a short, lowercase, hyphenated slug that matches the skill's name (for
example `commit-message`, `pr-review`, `linear-triage`). The slug must be
lowercase alphanumeric with hyphens only — `skill_validate` rejects anything
else. The skill folder is named after the slug.

## Step 3 — Write SKILL.md

Scaffold the file at `~/.nessy-agent/skills/<slug>/SKILL.md` **through your
normal file-writing tool**, so the write goes through the usual approval. Never
write outside `~/.nessy-agent/skills/` for a skill.

`SKILL.md` has YAML frontmatter followed by markdown instructions. Two
frontmatter fields are **required**:

- `name` — a human-readable display name.
- `description` — one or two sentences that say what the skill does and when to
  use it. This is the matching signal, so make it specific.

Optional frontmatter fields (see `~/.nessy-agent/docs/skills.md` for details):

- `globs` — file patterns that suggest the skill.
- `alwaysAllow` — tool names auto-allowed while the skill is active.
- `requiredSources` — source slugs to auto-enable when the skill is invoked.
- `icon` — an emoji or image URL for the UI.

Template:

```markdown
---
name: "Commit Message"
description: "Write conventional-commit messages for staged changes. Use when the user asks to commit or write a commit message."
alwaysAllow: ["Bash"]
---

# Commit Message

When creating a commit:

1. Inspect the staged diff to understand the change.
2. Use a conventional-commit subject (`feat:`, `fix:`, `docs:`, `refactor:`,
   `test:`, `chore:`), imperative mood, under 72 characters.
3. Explain *why* in the body when the change is not obvious.
```

Keep instructions concise, direct, and specific to the task. Add supporting
asset files only when the skill genuinely needs them, and nothing more.

## Step 4 — Validate

After writing the skill, run the `skill_validate` tool with the slug:

```
skill_validate({ skillSlug: "<slug>" })
```

It checks the slug format, that `SKILL.md` exists and parses, that the `name`
and `description` frontmatter fields are present, and that the body is
non-empty. Fix anything it reports, then re-run until it passes.

## Step 5 — Confirm

Tell the user clearly that the skill was created and validated, and where it
lives (`~/.nessy-agent/skills/<slug>/`). Mention that they can edit it directly
or manage it in the app.
