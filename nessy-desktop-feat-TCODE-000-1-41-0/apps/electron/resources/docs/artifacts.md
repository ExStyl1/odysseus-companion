# Publishing Pages (t-artifacts)

Nessy can put one page a session wrote — an `.html`, `.htm` or `.md` file — on the company's internal artifact service, `https://t-artifacts.t-tech.team`, and hand back a link. This guide says when that happens, what the user sees, and what the mechanism does NOT protect against.

## The tools

| Tool | What it does |
|------|--------------|
| `publish_artifact` | Publishes a file, or replaces the content of a page this workspace published before (pass its `url`). Every call shows the user a confirmation card first. |
| `list_artifacts` | Lists the pages THIS session published: id, title, link and expiry (`null` = never expires). Pages from other sessions are not listed. |

Both work on all three runtimes: Pi and Claude call them in process, codex over the host bridge. They reach ONE host path, so the card, the checks and the audit record are the same everywhere.

**Claude's own `Artifact` tool** publishes to claude.ai, so it is turned off. A call to it that arrives anyway (for example because a skill document names it) is routed to `publish_artifact`: a publish in that shape is accepted (`favicon` is read as the page emoji; `label`, `icon`, `force`, `capabilities` and `contract` are ignored), and every other action of that tool (`list`, `read`, `watch`, assets, deletion) is refused with a pointer to `list_artifacts`. Nothing is deleted through it.

## When the agent publishes

Only when the user asked, in this conversation, to publish or share a page. Otherwise the agent may offer it in one line of text; it never publishes on its own initiative. Writing a page, a Pages document or an inline preview is the agent's work; publishing it is the user's decision.

## What the user approves

Every create and every update raises a confirmation card, in every permission mode — `bypassPermissions` included. The card shows:

- who can open the page (anyone with the link) and the absolute expiry date;
- the file, its size and the start of its sha256;
- a preview of exactly the bytes that will be sent (Markdown rendered, HTML in a sandboxed frame with scripts off), plus the first 40 source lines;
- the number of scripts and the list of external hosts the page loads from;
- the automatic check's sentence: it found no known token formats, and it does not detect encoded or free-form secrets or client data;
- for an update, how the size and line count change against the last published version.

The approval cannot be remembered. A card nobody answers within 110 seconds counts as a refusal, and a session holds at most one waiting publish card. If the file changes after the card was raised, nothing is sent and a new card is raised.

## Expiry

The link stops working after `retention_days` days. An agent may ask for 1 to 30 days; a new page gets 7 by default. An update keeps the current expiry unless `retention_days` is passed. Longer or unlimited retention can only be set by the user in the app.

## Published pages

Settings → Workspace → Published pages lists every page your dp account published to t-artifacts — from this workspace (with the chat and file it came from) or elsewhere. Open or copy a link, extend its lifetime (7, 30, 90 days, a year, or no expiry — longer than 30 days can only be set here, never by the agent), or delete it. Deleting closes the link for everyone; copies readers already saved, and any service backups, are not recalled. If the delete cannot reach the service (for example dp is signed out), the page stays in the list as "Deletion pending" and is retried the next time the list loads after you sign in.

## Refused without sending anything

- Credential files and every path the permission floor already denies, `.env` files, and the artifact registry itself.
- Files outside the session's folders (its working directory, accepted added folders, the session folder).
- Anything other than `.html`, `.htm` or `.md`; pages over 16 MiB.
- Pages containing tokens (JWTs, `ory_*` tokens, bearer headers) or card numbers; password fields and forms.
- An update target that is not a page this workspace published — including any link on another site, such as a claude.ai link.
- Calls nobody can answer a card for: `dontAsk` mode, a subagent or a Pi child session, a turn started by an automation, a schedule or a goal continuation, or no open app window for the workspace.

## The shell path is redirected

On Pi and Claude, a shell command that names the service host, or the `artifact-publish` skill or package (`npx @loyalty-personalization/artifact-publish`), is refused with a pointer to `publish_artifact`. That path would skip the card and the checks and start an interactive login. The `artifact-publish` skill is not shipped with Nessy. A command that only searches files for one of those names is refused too; use the Grep tool for that.

## What this does NOT protect against (stated residues)

1. **The card is a consent control for the sanctioned path, not an egress control.** Any agent that can run shell commands with network access can reach the service, or any other host, directly: the shell redirect reads command text, so an encoded, assembled or scripted address passes it. On codex, shell commands are not checked by this redirect at all.
2. **Token custody.** Publishing sends your dp sign-in token (`dp auth print-token`, a platform-wide credential) to the t-artifacts service at `https://t-artifacts.t-tech.team`, which resolves it to your identity through devplatform. Nessy asks dp for the token on every request and never stores it. It is never your Nessy Gateway token, nothing from `~/.nessy/dp_auth_creds.json`, and never an `ARTIFACT_AUTH_TOKEN` / `T_ARTIFACTS_TOKEN` from the environment. When dp can mint a delegated token for the service, Nessy will switch to it.
3. **The link is the only access control.** Anyone on the company network with the link can open the page without signing in, and the page source can be downloaded by its id. Deleting a page closes the link for everyone, but copies readers already saved, and any service backups, are not recalled.
4. **Page scripts run in the readers' browsers.** The service's content policy allows scripts and CDNs; the card counts the scripts and lists the external hosts so the user sees them before approving.
5. **Codex waits long enough for the card.** Codex's own MCP call timeout defaults to 60 seconds, so Nessy sets it to at least 121 seconds for its session tools, above the card's 110-second window: a late approval or decline still reaches the model, and a card nobody answers within 110 seconds is declined. The audit record shows what happened.

## Audit

Every decision — approved, denied, refused as unattended, refused by the checks — appends a host-written record to the session: runtime, permission mode, source path, sha256, size, scan counts, script count, external hosts, retention and the decision. It never contains the page content or a token.
