# Deep Links

Nessy Desktop registers URL scheme `nessy://`, поэтому browser, script, launcher или teammate's document могут открыть specific view или trigger action in app. Link либо navigates focused window, либо, с window parameter, opens new one.

::: info
Links handled by desktop app deep-link router. Unrecognised host or malformed URL ignored rather than opening blank window.
:::

## New Session

Create session, optionally pre-filling or sending prompt:

```
nessy://action/new-session
nessy://action/new-session?input=Give%20me%20a%20status%20update
nessy://action/new-session?input=Give%20me%20a%20status%20update&send=true
nessy://action/new-session?input=Draft%20a%20plan&name=Planning
```

| Parameter | Effect |
| --------- | ------ |
| `input` | Text placed in composer |
| `send` | `true` sends `input` immediately instead of waiting |
| `name` | Names new session |
| `status` | Applies status (todo-state) ID to session |
| `label` | Applies label ID to session |
| `mode` | Starts in permission mode (`dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions`; упразднённый `explore` открывается в `plan`, а прежние написания вроде `safe`, `ask`, `allow-all` тоже работают) |
| `workdir` | Working directory (`user_default`, `none`, or a path) |
| `model` | Model to use for session |
| `systemPrompt` | System-prompt preset (`default`, `mini`, or preset ID) |

## View Routes

Open specific screen directly. Path may continue with `/session/{sessionId}` to select session inside view.

Sessions:

```
nessy://allSessions
nessy://allSessions/session/{sessionId}
nessy://flagged
nessy://flagged/session/{sessionId}
nessy://archived
nessy://state/{stateId}
nessy://state/{stateId}/session/{sessionId}
```

Sources and skills:

```
nessy://sources
nessy://sources/source/{sourceSlug}
nessy://skills
nessy://skills/skill/{skillSlug}
```

Страницы:

```
nessy://pages
nessy://pages/page/{pageSlug}
```

Settings — subpage segment matches settings page ID:

```
nessy://settings
nessy://settings/ai
nessy://settings/appearance
nessy://settings/workspace
nessy://settings/permissions
nessy://settings/shortcuts
nessy://settings/preferences
```

Full set of subpages: `app`, `ai`, `appearance`, `input`, `workspace`, `permissions`, `labels`, `server`, `shortcuts`, `preferences`.

## Session Actions

Act on existing session by ID:

```
nessy://action/flag-session/{sessionId}
nessy://action/unflag-session/{sessionId}
nessy://action/delete-session/{sessionId}
nessy://action/rename-session/{sessionId}?name=New%20Name
```

## Targeting a Workspace

By default link uses focused (or last active) window. Prefix any view/action route with `workspace/{workspaceId}` to route it to specific workspace instead — app focuses or opens window for that workspace:

```
nessy://workspace/{workspaceId}/allSessions
nessy://workspace/{workspaceId}/allSessions/session/{sessionId}
nessy://workspace/{workspaceId}/action/new-session?input=Hello&send=true
```

## Window Modes

Add `window=focused` or `window=full` to open target in new window rather than reusing existing one:

```
nessy://action/new-session?window=focused
nessy://allSessions?window=full
```

| Value | Result |
| ----- | ------ |
| `focused` | New focused window |
| `full` | New full window |

Parameter `sidebar` can request right-hand panel with target view. Both `window` and `sidebar` stripped from action parameters, so they never collide with route query values.

## Use Cases

- **Browser bookmarks** — save link like `nessy://action/new-session?input=Morning%20briefing&send=true` to start routine with one click.
- **Documentation** — embed link in team docs so readers open scoped conversation: `[Ask the assistant](nessy://action/new-session?input=How%20does%20auth%20work%3F)`.
- **Shell aliases** — wrap link in shortcut:

  ```bash
  alias standup="open 'nessy://action/new-session?input=Prepare%20my%20standup&send=true'"
  ```

- **Launchers** — Raycast, Alfred or macOS/iOS Shortcuts can fire `nessy://` URL from keystroke.

## Tips

- **URL-encode input.** Spaces become `%20`, `?` becomes `%3F`, `&` becomes `%26`, newlines `%0A`.
- **Test from terminal** before sharing link:

  ```bash
  open "nessy://action/new-session?input=Hello%20world"
  ```

- **Auto-send with care.** `send=true` runs prompt without confirmation step — convenient for trusted routines, but review permission mode first.

::: info
OAuth callbacks arrive on same scheme (`nessy://auth-callback?...`) and handled by authentication layer, not navigation router. Do not construct these by hand.
:::
