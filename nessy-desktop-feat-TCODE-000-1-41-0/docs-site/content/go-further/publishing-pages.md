# Publishing Pages

Nessy can publish a page a session wrote — an `.html`, `.htm` or `.md` file — to the company's internal artifact service (t-artifacts) and give you a link.

## How it works

- Ask the agent to publish or share a page. It never publishes on its own; at most it offers to.
- Publish from a preview: an HTML or Markdown preview of a file in a chat has a Publish button; it shows the same confirmation card as the agent's publish_artifact, with a preview of exactly what will be sent, and nothing is sent until you approve. The button is not offered for a preview that names no file, and a session that cannot show a card (Don't ask mode, a child agent session, a turn an automation or schedule started) refuses it.
- Every publish and every update shows a confirmation card, in every permission mode, Bypass included. The card shows who can open the page, when the link expires, the file, its size, a preview of exactly what will be sent, the number of scripts, the external hosts the page loads, and the result of an automatic check for tokens and card numbers. The approval cannot be remembered; an unanswered card is a refusal after 110 seconds.
- Links expire after 7 days by default. The agent may ask for 1 to 30 days; longer or unlimited retention is yours to set in the app.
- The agent can list the pages its own session published, and replace a page's content keeping the same link.
- Works the same on Pi, Claude Code and Codex.

## What is refused

Credential and `.env` files, files outside the session's folders, files other than `.html`/`.htm`/`.md`, pages over 16 MiB, pages containing tokens or card numbers, password fields and forms — and every publish nobody can approve: Don't ask mode, subagents, and runs started by automations, schedules or goal continuations.

Claude Code's own `Artifact` tool (which publishes to claude.ai) is turned off; a call to it is routed to the same card. On Pi and Claude Code, a shell command that calls the service or the `artifact-publish` skill is refused with a pointer to the publishing tool. The `artifact-publish` skill is not shipped.

## What to know before you approve

1. The card is your consent for this path, not a network fence: an agent that can run shell commands with network access could reach the service, or any other site, directly. On Codex, shell commands are not checked for this at all.
2. Publishing sends your dp sign-in token (dp auth print-token, a platform-wide credential) to the t-artifacts service at https://t-artifacts.t-tech.team, which resolves it to your identity through devplatform. Nessy asks dp for the token on every request and never stores it. It is never your Nessy Gateway token, nothing from ~/.nessy/dp_auth_creds.json, and never an ARTIFACT_AUTH_TOKEN / T_ARTIFACTS_TOKEN from the environment. When dp can mint a delegated token for the service, Nessy will switch to it.
3. Anyone on the company network with the link can open the page without signing in, and its source can be downloaded by id. Deleting a page closes the link, but copies readers saved, and service backups, are not recalled.
4. Scripts in the page run in your readers' browsers.

## Published pages

Settings → Workspace → Published pages lists every page your dp account published to t-artifacts — from this workspace (with the chat and file it came from) or elsewhere. Open or copy a link, extend its lifetime (7, 30, 90 days, a year, or no expiry — longer than 30 days can only be set here, never by the agent), or delete it. Deleting closes the link for everyone; copies readers already saved, and any service backups, are not recalled. If the delete cannot reach the service (for example dp is signed out), the page stays in the list as 'Deletion pending' and is retried the next time the list loads after you sign in.
