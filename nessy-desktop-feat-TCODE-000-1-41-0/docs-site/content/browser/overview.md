# Browser

Nessy Desktop ships with a Chromium window the agent can drive on your behalf. It can open URLs, read the page, click and type, run JavaScript, watch network traffic, and capture screenshots — the whole loop happens inside the conversation, so you never have to copy results back and forth.

## When to reach for the browser

Not every web task belongs in the browser. Use this quick split:

Good fit for the browser:

- One-off jobs where building a reusable integration would be overkill.
- Pure-UI flows for services that expose no API.
- Situations where a source is not set up yet and you need an answer now.
- Pulling data out of a rendered page (scraping, table extraction).
- Filling forms or walking through a multi-step wizard.

Better handled by a source:

- Anything you will run on a schedule or repeat often.
- Team-wide reporting and shared automation.
- Workflows that need a stable, programmatic contract.
- Cases where an [API](../sources/apis/overview) or [MCP server](../sources/mcp-servers/overview) already exists for the service.

## The interaction loop

Every browser task, no matter how complex, is built from the same cycle:

1. **Open a window** — the agent opens a Chromium window in the background, or reuses one that is already up (`open`, `focus`).
2. **Navigate** — load a URL, including pages where you are already signed in (`navigate <url>`).
3. **Inspect** — the agent takes a `snapshot`, a structured accessibility tree that tags every interactive element with a short reference such as `@e1`, `@e12`. It can also `find <keyword>` to locate a specific control.
4. **Act** — using those references it clicks, types, selects options, scrolls, and sends key presses.
5. **Read the result** — extract structured data with `evaluate`, capture a `screenshot`, or dump recent `network` requests to confirm what happened.

## What the agent can do

All browser actions run through a single `browser_tool` command, invoked CLI-style. It is offered in Pi and Claude Code sessions; Codex sessions do not drive the browser. The main capabilities:

| Capability | Commands | Notes |
| --- | --- | --- |
| Window control | `open`, `focus`, `windows`, `hide`, `release`, `close` | Manage one or more windows and hand control back to you |
| Navigation | `navigate`, `back`, `forward` | Follows links and history |
| Inspect page | `snapshot`, `find`, `screenshot`, `screenshot --annotated`, `screenshot-region` | Accessibility tree, keyword search, and full/targeted captures |
| Click & point | `click @e12`, `click-at 350 200`, `drag 100 200 300 400` | Reference-based or raw pixel coordinates (useful for canvas) |
| Text entry | `fill @e5 <value>`, `type <text>`, `select @e3 <value>` | Fill inputs, type into the focused element, choose dropdown options |
| Clipboard | `set-clipboard`, `get-clipboard`, `paste` | Paste tab/newline-separated data into fields |
| File upload | `upload @e3 /path/to/file` | Attach local files to a file input |
| Scripting | `evaluate <js>` | Run JavaScript in the page and read the return value |
| Network & console | `network 50 failed`, `console 50 error` | Inspect recent requests and console output |
| Timing | `wait network-idle 8000`, `downloads wait 15000` | Wait for the page or a download to settle |
| Keyboard | `key Enter`, `key k meta` | Single keys and modifier combos |
| Sizing | `window-resize 1440 900` | Set the viewport for consistent screenshots |

Commands can be batched in one call with semicolons (`fill @e1 a; fill @e2 b; click @e3`); the batch stops after any navigating command since the page state may change underneath it. Array form (`["evaluate", "var x = 1; x + 2"]`) preserves semicolons, tabs, and newlines inside arguments verbatim.

Quotes group an argument only when they open it: `fill @e5 "Hello world"` fills `Hello world`, while `fill @e5 Don't do this` types the apostrophe as written. A quote in the middle of a word is kept as text but still protects the semicolons inside it, so a selector such as `div[data-x='a;b']` works unquoted, and `\;` writes a literal semicolon. An argument whose opening quote never closes is refused before anything runs. The permission check reads a command with exactly the same rules as the browser that runs it, so a batch cannot look read-only to one and act to the other.

An annotated screenshot labels only the elements visible on screen and lists at most 50 of them, one short line each, so a capture does not flood the conversation.

## Permissions

Browser tools are available in every permission mode, including the read-only Plan mode, where commands that only read the page run freely and a command that changes the page or the browser's state asks first. The agent can browse, snapshot, and extract without escalating to a higher mode. See [Permissions](../core-concepts/permissions) for how modes work.

::: info
Before its first browser action in a session the agent loads a short usage guide for these tools, so you may notice a brief pause on the very first call. This is expected and keeps the agent from misusing the commands.
:::

## Passwords

When the agent fills a password field — a password input, or a field the page marks for a password, inside shadow DOM too — the result names only the field and how many characters went in, and typing or pasting into such a field shows a placeholder instead of the text. The stored transcript keeps the placeholder in the result and in the recorded command, and the card you see is redacted the same way once the result arrives. Ask the agent to use `fill` for passwords.

What this does not cover, as stated plainly: the model has seen the value it typed, a `PostToolUse` hook receives the original command, an Ask-mode permission card shows the full command at the moment it asks, and your own chat message is kept as you wrote it.

## Window lifecycle

A browser window stays alive across turns within a session. When the agent is finished it can end the window in one of three ways:

| Action | What happens | When to use |
| --- | --- | --- |
| `close` | Window is destroyed; all page state is lost | Task is fully done and the browser is no longer needed |
| `release` | The agent's control overlay is dismissed; the window stays open for you | Agent is done but you want to keep browsing |
| `hide` | Window is hidden but kept in memory | Temporarily done; the agent may need it again shortly |

Closing a window with the OS window control **hides** it rather than destroying it, so the agent can bring it back instantly.

## Hidden Windows and Sign-In Popups

On pages the app may drive through the browser's debugging channel, the agent's clicks, key presses and drags reach the page even while its window is hidden or behind another one; elsewhere they use ordinary input. When something covers the element it means to click — a banner, an overlay — the click falls back to a script click on the element, and the result says so and names what was covering it. Choosing an option in a dropdown matches it by value, label or visible text, and filling a field works with pages that track input in their own way (React forms among them).

All browser windows share one set of cookies. When a page asks for a sign-in popup — an identity provider or a login page — while another browser window of the same workspace already has that sign-in open, no second popup opens: the open one is brought forward for you, and the agent is told to let the sign-in finish and then reload its page. A popup that a click does open is reported to the agent too: you can see and use it, but the agent cannot control it.

## Windows are scoped to a workspace

Each browser window belongs to the [workspace](../go-further/workspaces) that opened it. Switch to a different workspace and the toolbar plus tab strip narrow down to just that workspace's windows, leaving windows from other workspaces running quietly in the background. A window you open by hand from the top bar obeys the same rule — it is tied to whatever workspace was active at the moment you opened it.

## Browser on remote workspaces

When you connect to a [remote workspace](../server/headless) from the desktop app, the agent on the server does not spawn its own headless Chromium. Instead it drives **your local browser** by calling back to the desktop client over the same WebSocket connection. The window opens on your machine, already signed in with your cookies and extensions.

::: info
Remote browsing needs the desktop app as the client. The browser tool is unavailable when the only connected client is the CLI.
:::

In practice this means:

- The window opens on your computer, not on the server.
- Your existing logins and cookies are reused, so there is no second sign-in on the remote side.
- Drop the desktop client partway through a task and the server's following browser action returns a prompt "client disconnected" failure instead of blocking indefinitely.
- Moving between workspaces never yanks a window out of the remote session; each window stays bound to whichever workspace launched it.

### Guard for remote JavaScript

`evaluate` executes whatever script you hand it against the live page. Since that page sits on **your** machine under **your** cookies, the desktop client puts remote script execution behind a local switch:

| Setting | Default | Effect when disabled |
| --- | --- | --- |
| `allowRemoteEvaluate` | `true` | Remote `evaluate` calls are rejected locally with `BROWSER_REMOTE_EVALUATE_BLOCKED`. Navigation, clicks, form fills, and screenshots keep working. |

Leave it off when a remote workspace you attach to is not one you fully trust. Set `"allowRemoteEvaluate": false` in `~/.nessy-agent/config.json`. The guard only applies to agents running on remote servers — local sessions are never affected. Uploading files across the remote bridge is disabled outright, because the source file would live on the remote host and cannot be handed to your local browser.
