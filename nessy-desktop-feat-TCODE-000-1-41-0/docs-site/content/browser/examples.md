# Examples & Recipes

Common browser patterns, described from the agent's point of view. In practice you just say what you want in plain language and the agent chooses the `browser_tool` commands — these recipes show what happens underneath.

## Log in and navigate

The agent can sign into a web app with your credentials and move to an authenticated page.

```text
"Go to app.example.com, log in with my credentials, and open the Reports page"
```

Under the hood:

1. It opens a window and loads the site's login page.
2. It takes a `snapshot` to locate the email/password inputs and the sign-in button, each tagged with a reference like `@e3`, `@e5`, `@e7`.
3. It uses `fill` on the input fields and `click` on the button.
4. It waits for the page to settle (`wait network-idle`) and then navigates on to the target page.

::: tip
If you are already logged into the site in the browser, the agent reuses that session — no need to sign in again.
:::

## Fill a multi-field form

The agent handles forms with text fields, dropdowns, and checkboxes.

```text
"Fill out the support-ticket form on our internal tool: set priority to High,
category to Billing, and describe it as 'Customer charged twice for subscription'"
```

It snapshots the form, matches each field by its label, uses `fill` for text and `select` for dropdown values, then clicks submit.

## Extract data from a page

Use `evaluate` to pull structured data out of any rendered page.

```text
"Open our analytics dashboard and extract the top 10 rows of the summary table"
```

The agent runs JavaScript directly in the page:

```javascript
Array.from(document.querySelectorAll('table.summary tr'))
  .slice(0, 10)
  .map(row => ({
    metric: row.cells[0].textContent,
    value: row.cells[1].textContent,
  }))
```

Whatever the snippet returns arrives as structured data, which the agent can then tabulate, hand off to a spreadsheet, or dig into further.

## Watch network traffic

See which backend calls a page makes — handy for debugging or for finding an internal endpoint.

```text
"Open the dashboard, click Refresh, and show me what API calls it makes"
```

The agent runs `network` to list what the page fired, reporting each request's URL, HTTP method, status code, and payload size. This is the starting point for [API discovery](./api-discovery).

## Capture a targeted screenshot

Grab a single element or region instead of the whole page with `screenshot-region`.

```text
"Take a screenshot of just the revenue chart on the dashboard"
```

The agent can target a capture by:

- **Element reference** — snapshot the page, find the chart's `@eN`, capture just that element (`screenshot-region --ref @e12`).
- **CSS selector** — target something like `screenshot-region --selector div[data-testid="revenue-chart"]`.
- **Coordinates** — capture a fixed pixel region (`screenshot-region 100 200 640 480`).

To label every interactive element on the current view, `screenshot --annotated` overlays the `@eN` references directly on the image.

## Send keyboard shortcuts

Trigger app-specific shortcuts with `key`.

```text
"Open the command palette with Cmd+K and search for 'billing'"
```

The agent sends the combo (`key k meta`) and can use any modifier — Shift, Control, Alt, or Meta/Cmd.

## Multi-step workflows

Chain several actions into one job.

```text
"Go to our HR portal, open each team member's profile, and compile their
job titles and departments into a spreadsheet"
```

When a task loops over many similar items like this, the agent often finds a faster route — see [API Discovery](./api-discovery) for how it finds an internal endpoint and pulls every record concurrently rather than opening each item by hand.

## Tips for best results

- **Be specific about the output.** "Pull each employee's name and email out of the table" beats "get the data."
- **Say if you are already logged in.** It lets the agent skip the sign-in flow.
- **Describe a complex layout.** "Look in the second tab, in the Summary section" saves a lot of hunting.
- **Ask for a format.** "Return it as a spreadsheet" or "lay it out as a table" gets you the shape you want the first time.

## Troubleshooting

- **Page not loading.** The agent retries navigation. If it keeps failing, double-check the URL and that the site is reachable.
- **Element not found.** The agent re-snapshots after navigation. For content that loads dynamically it may need to `wait` or scroll before the element appears.
- **Login not working.** CAPTCHAs and multi-factor prompts cannot be automated. Handle the sign-in yourself first, then hand the session back to the agent to carry on.
- **Flaky interactions.** The agent re-snapshots and retries. Pages with animations may need a brief `wait` between actions.
