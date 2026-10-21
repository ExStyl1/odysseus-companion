# Memory

Every Nessy CLI session starts with a fresh context window. Two mechanisms carry knowledge across sessions so you don't have to re-explain yourself every time:

- **NESSY.md** — instructions _you_ write once and Nessy reads every session
- **Auto-memory** — notes Nessy writes itself based on what it learns from you

---

## NESSY.md: your instructions to Nessy

NESSY.md is a plain text file where you write things Nessy should always know about your project or your preferences. Think of it as a permanent briefing that loads at the start of every conversation.

### What to put in NESSY.md

Add things you'd otherwise have to repeat every session:

- Build and test commands (`npm run test`, `make build`)
- Coding conventions your team follows ("all new files must have JSDoc comments")
- Architectural decisions ("we use the repository pattern, never call the database directly from controllers")
- Personal preferences ("always use pnpm, not npm")

Don't include things Nessy can figure out by reading your code. NESSY.md works best when it's short and specific — the longer it gets, the less reliably Nessy follows it.

### Where to create NESSY.md

| File                          | Who it applies to                                |
| ----------------------------- | ------------------------------------------------ |
| `~/.nessy/NESSY.md`             | You, across all your projects                    |
| `NESSY.md` in the project root | Your whole team (commit it to source control)    |
| `.nessy/NESSY.local.md`         | Only you, only in this project (keep out of git) |

You can have any combination of these. Nessy loads all of them when you start a session.

If your repository already has an `AGENTS.md` file for other AI tools, Nessy reads that too. No need to duplicate instructions.

#### When to use `.nessy/NESSY.local.md`

Use it for **project-specific but personal** instructions — things that belong to this project but shouldn't be shared with the team:

- Your own cluster ID, container registry namespace, or cloud account
- A personal debug command that hardcodes your local environment
- Notes you want Nessy to know about your work-in-progress, but not commit

It loads **after** the shared project `NESSY.md`, so your local instructions can supplement or override the team's.

**You must gitignore it yourself.** Although `.nessy/` is often treated as a local directory, nessy-cli does not generate a `.gitignore` for you, and some projects commit `.nessy/settings.json`. Add this line to your `.gitignore` (or to your global git ignore):

```
.nessy/NESSY.local.md
```

### Generate one automatically with `/init`

Run `/init` and Nessy will analyze your codebase to create a starter NESSY.md with build commands, test instructions, and conventions it finds. If one already exists, it suggests additions instead of overwriting.

### Reference other files

You can point NESSY.md at other files so Nessy reads them too:

```markdown
See @README.md for project overview.

# Conventions

- Git workflow: @docs/git-workflow.md
```

Use `@path/to/file` anywhere in NESSY.md. Relative paths resolve from the NESSY.md file itself.

---

## Auto-memory: what Nessy learns about you

Auto-memory runs in the background. After each of your conversations, Nessy quietly saves useful things it learned — your preferences, feedback you gave, project context — so it can use them in future sessions without you repeating yourself.

This is different from NESSY.md: you don't write it, Nessy does.

### What Nessy saves

Nessy looks for four kinds of things worth remembering:

| What                    | Examples                                                 |
| ----------------------- | -------------------------------------------------------- |
| **About you**           | Your role, background, how you like to work              |
| **Your feedback**       | Corrections you made, approaches you confirmed           |
| **Project context**     | Ongoing work, decisions, goals not obvious from the code |
| **External references** | Dashboards, ticket trackers, docs links you mentioned    |

Nessy doesn't save everything — only things that would actually be useful next time.

### Where it's stored

Auto-memory files live at `~/.nessy/projects/<project>/memory/`. All branches and worktrees of the same repository share the same memory folder, so what Nessy learns in one branch is available in others.

Everything saved is plain markdown — you can open, edit, or delete any file at any time.

### Periodic cleanup

Nessy periodically goes through its saved memories to remove duplicates and clean up outdated entries. This runs automatically in the background once a day after enough sessions have accumulated. You can trigger it manually with `/dream` if you want it to run now.

While cleanup is running, **✦ dreaming** appears in the corner of the screen. Your session continues normally.

### Turning it on or off

Auto-memory is on by default. To toggle it, open `/memory` and use the switches at the top. You can turn off just the automatic saving, just the periodic cleanup, or both.

You can also set them in `~/.nessy/settings.json` (applies to all projects) or `.nessy/settings.json` (this project only):

```json
{
  "memory": {
    "enableManagedAutoMemory": true,
    "enableManagedAutoDream": true
  }
}
```

---

## Commands

### `/memory`

Opens the Memory panel. From here you can:

- Turn auto-memory saving on or off
- Turn periodic cleanup (dream) on or off
- Open your personal NESSY.md (`~/.nessy/NESSY.md`)
- Open the project NESSY.md
- Browse the auto-memory folder

### `/init`

Generates a starter NESSY.md for your project. Nessy reads your codebase and fills in build commands, test instructions, and conventions it discovers.

### `/remember <text>`

Immediately saves something to auto-memory without waiting for Nessy to pick it up automatically:

```
/remember always use snake_case for Python variable names
/remember the staging environment is at staging.example.com
```

### `/forget <text>`

Removes auto-memory entries that match your description:

```
/forget old workaround for the login bug
```

### `/dream`

Runs the memory cleanup now instead of waiting for the automatic schedule:

```
/dream
```

---

## Troubleshooting

### Nessy isn't following my NESSY.md

Open `/memory` to see which files are loaded. If your file isn't listed, Nessy can't see it — make sure it's in the project root or `~/.nessy/`.

Instructions work better when they're specific:

- ✓ `Use 2-space indentation for TypeScript files`
- ✗ `Format code nicely`

If you have multiple NESSY.md files with conflicting instructions, Nessy may behave inconsistently. Review them and remove any contradictions.

### I want to see what Nessy has saved

Run `/memory` and select **Open auto-memory folder**. All saved memories are readable markdown files you can browse, edit, or delete.

### Nessy keeps forgetting things

If auto-memory is on but Nessy doesn't seem to remember things across sessions, try running `/dream` to force a cleanup pass. Also check `/memory` to confirm both toggles are enabled.

For things you always want Nessy to remember, add them to NESSY.md instead — auto-memory is best-effort, NESSY.md is guaranteed.
