# Deep Links

Nessy Desktop registers the `nessy://` URL scheme, so a browser, script, launcher, or teammate's document can open a specific view or trigger an action in the app. A link either navigates the focused window or, with a window parameter, opens a new one.

::: info
Links are handled by the desktop app's deep-link router. An unrecognised host or malformed URL is ignored rather than opening a blank window.
:::

## New Session

Create a session, optionally pre-filling or sending a prompt:

```
nessy://action/new-session
nessy://action/new-session?input=Give%20me%20a%20status%20update
nessy://action/new-session?input=Give%20me%20a%20status%20update&send=true
nessy://action/new-session?input=Draft%20a%20plan&name=Planning
```

| Parameter      | Effect |
| -------------- | ------------------------------------------------------ |
| `input`        | Text placed in the composer |
| `send`         | `true` sends `input` immediately instead of waiting |
| `name`         | Names the new session |
| `status`       | Applies a status (todo-state) ID to the session |
| `label`        | Applies a label ID to the session |
| `mode`         | Starts in a permission mode (`dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions`; the retired `explore` opens in `plan`, and legacy spellings like `safe`, `ask`, `allow-all` still work) |
| `workdir`      | Working directory (`user_default`, `none`, or a path) |
| `model`        | Model to use for the session |
| `systemPrompt` | System-prompt preset (`default`, `mini`, or a preset ID) |

## View Routes

Open a specific screen directly. The path may continue with `/session/{sessionId}` to select a session inside that view.

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

Pages:

```
nessy://pages
nessy://pages/page/{pageSlug}
```

Settings — the subpage segment matches a settings page ID:

```
nessy://settings
nessy://settings/ai
nessy://settings/appearance
nessy://settings/workspace
nessy://settings/permissions
nessy://settings/shortcuts
nessy://settings/preferences
```

The full set of subpages is `app`, `ai`, `appearance`, `input`, `workspace`, `permissions`, `labels`, `server`, `shortcuts`, and `preferences`.

## Session Actions

Act on an existing session by ID:

```
nessy://action/flag-session/{sessionId}
nessy://action/unflag-session/{sessionId}
nessy://action/delete-session/{sessionId}
nessy://action/rename-session/{sessionId}?name=New%20Name
```

## Targeting a Workspace

By default a link uses the focused (or last active) window. Prefix any view or action route with `workspace/{workspaceId}` to route it to a specific workspace instead — the app focuses or opens a window for that workspace:

```
nessy://workspace/{workspaceId}/allSessions
nessy://workspace/{workspaceId}/allSessions/session/{sessionId}
nessy://workspace/{workspaceId}/action/new-session?input=Hello&send=true
```

## Window Modes

Add `window=focused` or `window=full` to open the target in a new window rather than reusing an existing one:

```
nessy://action/new-session?window=focused
nessy://allSessions?window=full
```

| Value     | Result |
| --------- | -------------------- |
| `focused` | New focused window |
| `full`    | New full window |

A `sidebar` parameter can also request that a right-hand panel open with the target view. Both `window` and `sidebar` are stripped from action parameters, so they never collide with a route's own query values.

## Use Cases

- **Browser bookmarks** — save a link like `nessy://action/new-session?input=Morning%20briefing&send=true` to kick off a routine with one click.
- **Documentation** — embed a link in team docs so readers can open a scoped conversation: `[Ask the assistant](nessy://action/new-session?input=How%20does%20auth%20work%3F)`.
- **Shell aliases** — wrap a link in a shortcut:

  ```bash
  alias standup="open 'nessy://action/new-session?input=Prepare%20my%20standup&send=true'"
  ```

- **Launchers** — Raycast, Alfred, or macOS/iOS Shortcuts can fire a `nessy://` URL from a keystroke.

## Tips

- **URL-encode input.** Spaces become `%20`, `?` becomes `%3F`, `&` becomes `%26`, newlines `%0A`.
- **Test from a terminal** before sharing a link:

  ```bash
  open "nessy://action/new-session?input=Hello%20world"
  ```

- **Auto-send with care.** `send=true` runs the prompt without a confirmation step — convenient for trusted routines, but review the permission mode first.

::: info
OAuth callbacks arrive on the same scheme (`nessy://auth-callback?...`) and are handled by the authentication layer, not the navigation router. You do not construct these by hand.
:::
