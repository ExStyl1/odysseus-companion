# Projects

A project groups the sessions and pages of one effort — a service you maintain, a long-running investigation, a team area — and carries context that every session bound to it receives. Projects are listed in the sidebar, after **Sources**.

## The Project Page

Open a project from the sidebar's **Projects** entry (after **Sources**). The project page has three tabs: **Sessions**, **Assets** and **Settings**. A project may have a folder, bound through the folder picker and shown with its trust.

## Binding Sessions

Bind a session to a project from the session menu: **Projects** picks the project the session belongs to. Binding changes what the agent receives — see Project context below — and where the session shows up in filtered lists.

## Finding A Project's Work

- In the session list, **Filter → Projects** narrows the list to a project's sessions, and **Group by → Project** groups them.
- **Settings → Appearance → Project color highlight** tints a project's rows: **Stripe only** or **Stripe + tint**.

## Pages In A Project

The Pages library filters by project, and **Move to project** moves a page between projects. See [Pages](../pages/overview).

## Project Context

When a session is bound to a project, the agent receives the project's name, description and details at the start of the conversation and again whenever they change. Nessy writes this text itself (`projects/<slug>/context.md`) and checks it against its approvals ledger before each turn, so an edit made to that file outside the app is replaced by the app's own copy. A project without a folder also has project memory, delivered with this context — see [Project Memory](#project-memory). A project with a folder uses that folder's own `.nessy-agent/MEMORY.md` instead.

## Project Memory

A project without a folder keeps a memory file, `MEMORY.md`, beside its settings (`projects/<slug>/MEMORY.md` in the workspace). Every session bound to the project receives it with the project context, and a change to the file reaches the next turn. Use it for what should outlive one conversation: a decision, a convention, a pitfall, a preference.

Sessions add to it; they do not rewrite it:

- The agent adds a note with the `project_memory_append` tool. The note, up to 4,000 characters, is appended at the end of the file under a heading with the date and time and the session's name, and nothing else in the file changes. Two sessions of the same project adding notes at the same time keep both notes.
- The agent is told never to rewrite `MEMORY.md` with its file tools, because other sessions add notes while it works and its own copy is only a snapshot; to correct a note, it appends the correction.
- In a session that is not bound to a project, the tool refuses.
- The tool is the same on Pi, Claude Code and Codex.

A long memory is shortened for the agent to about 5,000 tokens: the beginning (30 %) and the end (70 %) are kept, with a marker where the middle is left out, so the newest notes — which are at the end — always arrive. The file itself is never shortened, and you can edit it yourself at any time.

A project with a folder has no separate project memory: the folder's own `.nessy-agent/MEMORY.md` is its memory.
