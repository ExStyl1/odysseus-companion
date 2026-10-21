# Pages

A page is a small HTML app or report that lives in the workspace and opens in the app, under the sidebar's **Pages** entry. Use a page for something that outlives the conversation: a dashboard, a report you come back to, a tracker the agent keeps feeding with data.

## Kinds

| Kind | Script | Use for |
| ---- | ------ | ------- |
| `static` | none | fixed documents and formatted reports |
| `interactive` (the default) | inline JS | calculators, explorers, small tools |
| `live` | inline JS, and receives new data while open | dashboards you keep feeding with data |

## The Library

The Pages library shows a preview poster of each page. It is captured offscreen, without network access, whenever the page's content changes; use Refresh preview on a tile or in the page's menu to capture it again.

## Page Actions

A page can ask to run an action for you — a call to one of your sources or a script in the workspace. Nothing runs until you approve it: the page asks when you click one of its buttons, and the app shows exactly what would run (for a script, its path and a fingerprint of its contents). An approval is kept by the app for 30 days and only for this version of the page; if the page changes, or a script changes, you are asked again. You can remove any approval from the page's **⋯** menu → **Approved actions**. Every action is recorded in the app's log.

## Scheduled Refresh

A page can update its own data on a schedule, with no agent session and no tokens: an agent gives the page a refresh script and a five-field cron schedule (at most every 5 minutes), and the app keeps the script beside the page and runs it with Bun. A bar above the page shows the schedule and where the script stands: **Waiting for your approval**, **Approved**, **Script changed since approval**, **Paused**, **Running…** or **Script unavailable** (set the refresh again with an agent).

- **Nothing runs until you approve it.** **Review and approve** shows the exact command line, the script's fingerprint and its whole text. The approval binds those exact bytes with their arguments and runtime: any change to the script, by an agent or by hand, stops the refresh until you approve it again. Changing only the schedule keeps the approval.
- **Run now** runs an approved refresh at once; the bar says **Running…** until the run finishes. A failed run shows its error above the page.
- **A refresh that is not approved, or whose script changed, is not scheduled** — the bar says so, and automation history has no entry for it. An organisation policy that turns off local automations stops page refreshes too. If the script changes between the app's check and a scheduled run, that run is refused and automation history records it with the reason. A refused **Run now** says why in a notice.
- The script runs on your computer from the workspace folder, with network access and no secrets in its environment.

## Agents And Pages

Agents work with Pages through six tools — list_pages, get_page, create_page, update_page, write_page_data and delete_page — on Pi, Claude and Codex (Codex over its per-session link). Deleting a page always asks you first, in every permission mode.

## Publishing

A page's **Share** button publishes a view-only copy to the company's internal artifact service — see [Publishing Pages](../go-further/publishing-pages) and [Sharing](../go-further/sharing).
