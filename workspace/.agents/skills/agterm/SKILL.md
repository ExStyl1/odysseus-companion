---
name: "agterm"
description: "Управление приложением agterm через agtermctl и локальный управляющий сокет."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

### Supplied package dependencies

- The supplied folder does not contain scripts/show-image.sh; that optional inline-image helper needs to be supplied separately.

---


# agterm Skill for Nessy CLI

Drive agterm, a native macOS terminal app, programmatically via its `agtermctl` CLI and a local control socket.
Use when running inside an agterm session and asked to control the terminal: create, rename, close, select, or
reorder sessions and workspaces; split panes; toggle the per-session scratch terminal; open or close overlay
terminals and read their exit status; display an image inline via a bundled helper script; type into a session,
copy its selection, or search its scrollback; post desktop notifications; manage windows; change font size; or
reload and edit the keymap and the agterm-scoped ghostty config.

## Activation Triggers

- "agterm", "agtermctl", "agterm control socket"
- "session.new", "session.close", "session.type", "session.split", "session.scratch"
- "overlay open", "workspace.new", "window.new", "window.list"
- "toggle scratch", "create session", "split pane"
- "show an image", "display image inline"
- "set agent status", "agent glyph"
- "reload keymap", "edit keymap"
- "agterm logs", "troubleshoot agterm"

## Prerequisites

**Check if inside agterm**: Before assuming the control channel is available, verify:

```bash
echo $AGTERM_ENABLED  # Should be "1" if inside agterm
```

If unset, agterm is not available — inform the user and fall back to regular terminal operations.

**agtermctl on PATH**: The CLI tool must be installed. If not found, guide the user to install via
**Help ▸ Install Command Line Tool…** in the agterm app.

## The Model

**Window** — Top-level container rendered in its own macOS window. Each window holds a tree of workspaces.

**Workspace** — A grouping within a window. Each workspace holds sessions.

**Session** — A primary shell with optional:
- **Split pane** — side-by-side second shell
- **Scratch terminal** — full-coverage third shell (toggled)
- **Overlay** — ephemeral program running on top

**Quick terminal** — Per-window scratch overlay (not in session tree)

**Addressing**:
- `active` — the selected session / current workspace (default target)
- UUID (full or unique prefix) — case-insensitive
- **Critical for agents**: `active` is the USER's GUI-selected session, NOT yours. Your shell runs in
  `$AGTERM_SESSION_ID`. Always pass `--target "$AGTERM_SESSION_ID"` for session-scoped commands that
  must act on your own session.

## Environment Variables

Inherited by shells spawned by agterm:

- `AGTERM_ENABLED=1` — inside agterm
- `AGTERM_SESSION_ID` — current session UUID
- `AGTERM_WINDOW_ID` — owning window UUID
- `AGTERM_WORKSPACE_ID` — owning workspace UUID
- `AGTERM_SOCKET` — control socket path
- `AGTERM_PANE` / `AGTERM_PANE_ID` — pane role (`left`|`right`|`scratch`) and stable token

**Important**: Long-lived daemons (tmux, background services) started inside agterm inherit these variables.
Scrub them before starting such processes to avoid reporting to the wrong session:

```bash
env -u AGTERM_ENABLED -u AGTERM_SESSION_ID -u AGTERM_SOCKET -u AGTERM_WINDOW_ID -u AGTERM_WORKSPACE_ID -u AGTERM_PANE -u AGTERM_PANE_ID <cmd>
```

## Core Commands

### Inspect State

```bash
agtermctl tree --json        # Full workspace/session tree
agtermctl window list --json # List all windows
```

### Session Management

```bash
# Create session (returns new ID)
agtermctl session new --cwd DIR --workspace W --name NAME --command CMD --json

# Place session after/before another (headline: create right after current)
agtermctl session new --after active

# Close session(s)
agtermctl session close --target ID

# Rename
agtermctl session rename "new-name" --target ID

# Split pane (side-by-side second shell)
agtermctl session split on --target ID
agtermctl session split off --target ID  # hide (keeps alive)

# Scratch terminal (full-coverage third shell)
agtermctl session scratch on --target ID
agtermctl session scratch off --target ID  # hide (keeps alive)
agtermctl session scratch on --command "zsh -lc 'lazygit'" --target ID  # run program

# Focus split panes
agtermctl session focus left --target ID
agtermctl session focus right --target ID
agtermctl session focus other --target ID  # toggle

# Resize split divider
agtermctl session resize --split-ratio 0.7 --target ID  # left pane 70%
agtermctl session resize --grow-left 0.05 --target ID   # nudge left by 5%
```

### Type and Read

```bash
# Type into session (real keystrokes, includes Enter for newlines)
agtermctl session type "ls -la"$'\n' --target ID
agtermctl session type --stdin --target ID < file.txt

# Type into specific pane
agtermctl session type "cmd"$'\n' --target ID --pane right   # split pane
agtermctl session type "cmd"$'\n' --target ID --pane scratch # scratch (even hidden)

# Copy selection (does NOT touch system clipboard)
agtermctl session copy --target ID --json | jq -r '.result.text'

# Select all + copy
agtermctl session select-all --target ID
agtermctl session copy --target ID --json | jq -r '.result.text'

# Paste system clipboard (⌘V equivalent)
agtermctl session paste --target ID

# Read session buffer as plain text
agtermctl session text --target ID              # visible screen
agtermctl session text --all --target ID        # full scrollback
agtermctl session text --lines 50 --target ID   # last 50 lines
agtermctl session text --pane scratch --all --target ID  # scratch buffer
```

### Overlay (Run Program on Top)

```bash
# Open blocking overlay (wait for exit)
agtermctl session overlay open "make test" --target ID --block

# Open background overlay (user visits to see)
agtermctl session overlay open "revdiff HEAD~3" --target ID

# Floating panel (1-100% size)
agtermctl session overlay open "htop" --target ID --size-percent 70

# With custom background color
agtermctl session overlay open "cmd" --target ID --size-percent 80 --background-color "#2a1a3a"

# Switch user to overlay as it opens
agtermctl session overlay open "cmd" --target ID --follow

# Resize open overlay
agtermctl session overlay resize --size-percent 60 --target ID
agtermctl session overlay resize --full --target ID

# Close overlay
agtermctl session overlay close --target ID

# Read exit status
agtermctl session overlay result --target ID --json
```

### Workspace Management

```bash
# Create workspace (returns ID)
agtermctl workspace new "build" --json

# Rename
agtermctl workspace rename "new-name" --target ID

# Delete
agtermctl workspace delete --target ID

# Select
agtermctl workspace select --target ID

# Move (reorder)
agtermctl workspace move --to up --target ID
agtermctl workspace move --to bottom --target ID

# Focus (collapse sidebar to single workspace)
agtermctl workspace focus on --target ID
agtermctl workspace focus off  # restore full tree
```

### Window Management

```bash
# Create window
agtermctl window new "scratch" --json

# List windows
agtermctl window list --json

# Select window
agtermctl window select ID

# Close window
agtermctl window close ID

# Resize
agtermctl window resize ID --width 1200 --height 800

# Move
agtermctl window move ID --x 100 --y 100 --display 0

# Zoom (maximize to screen toggle)
agtermctl window zoom ID

# Fullscreen (native macOS)
agtermctl window fullscreen ID
```

### Agent Status Glyph

Set sidebar agent status for attention signaling:

```bash
# Working (with blink)
agtermctl session status active --blink --target ID

# Completed (one-shot flash)
agtermctl session status completed --auto-reset --target ID

# Blocked (needs input, with sound)
agtermctl session status blocked --sound default --target ID
agtermctl session status blocked --sound Glass --target ID  # named sound

# Custom color tint (this call only)
agtermctl session status blocked --color '#ff0000' --target ID

# Tag specific pane (so navigation lands on it)
agtermctl session status blocked --pane right --target ID   # split pane
agtermctl session status blocked --pane scratch --target ID # scratch

# Clear
agtermctl session status idle --target ID
```

### Notifications

```bash
# Desktop notification
agtermctl notify "build finished" --title "CI"
agtermctl notify "tests failed" --target ID
```

### Background Watermark

```bash
# Image watermark
agtermctl session background image /path/to/logo.png --fit cover --opacity 0.2 --target ID

# Text watermark
agtermctl session background text "STAGING" --color '#ff5500' --opacity 0.15 --target ID

# Solid color
agtermctl session background color '#3a0d0d' --target ID

# Clear
agtermctl session background clear --target ID
```

### Search

```bash
# Search scrollback
agtermctl session search "error" --target ID
agtermctl session search --next --target ID
agtermctl session search --prev --target ID
agtermctl session search --close --target ID
```

### Flag Working Set

```bash
# Flag session for flagged view
agtermctl session flag on --target ID
agtermctl session flag off --target ID
agtermctl session flag clear  # unflag all

# View flagged sessions only
agtermctl sidebar mode flagged
agtermctl sidebar mode tree  # back to full tree
```

### Quick Terminal

```bash
# Show/hide quick terminal
agtermctl quick show
agtermctl quick hide
agtermctl quick toggle

# Type into quick terminal
agtermctl quick type 'ls -la'$'\n'

# Read quick terminal buffer
agtermctl quick text --all
```

### Dashboard (Multi-Session Grid)

```bash
# Grid of specific sessions (auto-sized cells)
agtermctl dashboard "$id1" "$id2" "$id3" --auto-size

# Most-recently-used sessions
agtermctl dashboard --mru --auto-size

# Absolute font size
agtermctl dashboard "$id1" "$id2" --font-size 12

# Close dashboard
agtermctl dashboard --close
```

### Surface Zoom

```bash
# Zoom active surface
agtermctl surface zoom show
agtermctl surface zoom hide
agtermctl surface zoom toggle

# Zoom specific surface by ID
agtermctl surface zoom show --target "surface:ID:right"
```

### Sidebar

```bash
# Show/hide sidebar
agtermctl sidebar show
agtermctl sidebar hide
agtermctl sidebar toggle

# Expand/collapse all workspaces
agtermctl sidebar expand
agtermctl sidebar collapse

# Mode
agtermctl sidebar mode tree
agtermctl sidebar mode flagged
```

### Font

```bash
# Change font size
agtermctl font inc --target ID
agtermctl font dec --target ID
agtermctl font reset --target ID
agtermctl font inc --pane right --target ID  # split pane
agtermctl font inc --pane scratch --target ID  # scratch
```

### Keymap and Config

```bash
# Reload keymap after editing
agtermctl keymap reload

# Reload ghostty config
agtermctl config reload
```

### Theme

```bash
# List themes
agtermctl theme list

# Set theme (light slot)
agtermctl theme set theme-name

# Set dark theme (tracks macOS Light/Dark)
agtermctl theme set --dark theme-name

# Stop tracking dark mode
agtermctl theme set --dark none
```

### Restore Commands

Clear saved foreground commands (restore-on-restart):

```bash
agtermctl restore clear
```

### Acknowledge Notifications Without Focus Change

```bash
# Clear unseen badge without selecting session
agtermctl session seen --target ID
```

### Launching TUI Apps in Overlay

Launch long-running TUI apps (revdiff, htop, lazygit) in an overlay with `--follow`:

```bash
# Launch revdiff in overlay (switches user focus)
agtermctl session overlay open "revdiff HEAD~1" --target "$AGTERM_SESSION_ID" --follow

# Launch revdiff with untracked files
agtermctl session overlay open "revdiff --untracked" --target "$AGTERM_SESSION_ID" --follow

# Launch any TUI app (htop, lazygit, btop)
agtermctl session overlay open "htop" --target "$AGTERM_SESSION_ID" --follow

# With floating panel (50-100% size)
agtermctl session overlay open "lazygit" --target "$AGTERM_SESSION_ID" --follow --size-percent 80
```

**Key flags:**
- `--follow` — switch user focus to overlay (they see it immediately)
- `--target ID` — target session (use `$AGTERM_SESSION_ID` for your own session)
- `--size-percent N` — floating panel size (1-100%)
- Overlay closes automatically when command exits

**Pattern for Nessy CLI skills:**

1. Check `AGTERM_ENABLED` — skip if unset (not inside agterm)
2. Launch TUI: `agtermctl session overlay open "<tui-command>" --target "$AGTERM_SESSION_ID" --follow`
3. Inform user: "TUI launched in overlay"
4. User interacts in overlay
5. TUI exits — overlay closes, user returns to main session

**Benefits of overlay mode:**
- Simple — no scratch toggle complexity
- Auto-focus with `--follow` — user sees TUI immediately
- Clean lifecycle — overlay closes when app exits
- Adjustable viewport with `--size-percent`

## Displaying Images Inline

Use the bundled `scripts/show-image.sh` helper (adapt path for Nessy CLI):

```bash
bash ~/.nessy/skills/agterm/scripts/show-image.sh /abs/path/to/img.png [size-percent]
```

This opens an overlay and renders the image via kitty graphics protocol (native in ghostty/agterm).
Do NOT print graphics escapes to tool stdout — the overlay's real terminal renders it.

Outside agterm (`AGTERM_ENABLED` unset), fall back to `open img.png`.

## Troubleshooting

### Agent Status Updates Wrong Session

If agent-status glyph updates the wrong session, the process inherited poisoned `AGTERM_*` variables.
Scrub them before starting long-lived daemons:

```bash
env -u AGTERM_ENABLED -u AGTERM_SESSION_ID -u AGTERM_SOCKET \
    -u AGTERM_WINDOW_ID -u AGTERM_WORKSPACE_ID \
    -u AGTERM_PANE -u AGTERM_PANE_ID \
    tmux new-session -d  # or other daemon
```

### Keymap Editor Won't Open

Check parse diagnostics:

```bash
agtermctl keymap reload  # prints diagnostic count
```

Read logs:

```bash
log show --predicate 'subsystem == "com.umputun.agterm"' --last 5m
```

### Custom Action Not Working

Verify command path and syntax in `keymap.conf`. Test manually:

```bash
agtermctl <command>  # verify it works from shell
```

### Filing Issues

**Bug** (supported feature misbehaving) → GitHub **issue**
**Feature request / question** → GitHub **Discussion**

Always ask user approval before running `gh` commands. Draft-first approach.

## Key Principles

- **Always check `AGTERM_ENABLED`** before assuming agterm is available
- **Target your own session**: `--target "$AGTERM_SESSION_ID"` for session-scoped commands
- **Fire-and-forget**: No terminal-output streaming or event subscription
- **One request per invocation**: Each `agtermctl` call is independent
- **Options after subcommand**: `agtermctl session type "ls" --target active`, not before
- **Use `--json` for machine-readable output**: Capture IDs and values
- **Scratch terminal is expendable**: `--command` respawns if already open
- **Overlay opens in background**: Add `--follow` to switch user to it
- **Pane-scoped status**: `--pane right`/`scratch` so navigation lands on correct pane
