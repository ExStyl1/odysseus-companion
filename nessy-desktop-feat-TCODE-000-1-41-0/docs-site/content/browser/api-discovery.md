# API Discovery

This is the single highest-leverage browser pattern. Rather than clicking through a web UI one row at a time, the agent watches which backend calls the page makes, works out the pattern, and then calls those endpoints directly — often turning a multi-minute click-through into a couple of seconds.

## The idea

Most modern web apps are single-page applications that talk to a backend over `fetch()` or XHR. Every time you open an employee record, a ticket, or an order, the page is quietly hitting an internal API. Those requests are visible in the network log, and once the agent understands the shape of one, it can reproduce it for every item at once — skipping the slow UI entirely.

::: info
You do not have to ask for this by name. When the agent notices it is opening many similar items one after another, it will often switch to this approach on its own.
:::

## Why it is worth it

| | Clicking through the UI | Calling the API directly |
| --- | --- | --- |
| Speed per item | 5–10 seconds | roughly 100 milliseconds |
| Parallelism | One at a time | All items at once |
| Data format | Text scraped off the page | Structured JSON or XML |
| Reliability | Breaks when the UI changes | Rides stable API contracts |
| Auth | Already signed in | Reuses the same browser session |

For a request like "pull the time-off totals for 25 people", that is the difference between a few minutes of clicking and a couple of seconds of parallel calls.

## How it works

1. **Interact once.** The agent loads the app and clicks through a single item normally — just far enough to make the page fire its API calls.

2. **Inspect the traffic.** Using `network`, the agent reviews the requests the page issued and picks out the REST or GraphQL endpoints returning structured data:

   ```text
   GET /api/v1/employees/132/time-off?end=2026-12-31 → 200 (JSON, 1.2KB)
   GET /api/v1/employees/132?fields=department,jobTitle → 200 (JSON, 0.4KB)
   ```

3. **Spot the pattern.** It recognises the template — `/api/v1/employees/{id}/time-off` — and now knows how to build the request for any id.

4. **Verify with one call.** Before scaling up, the agent runs a single `evaluate` to confirm the endpoint works:

   ```javascript
   fetch('/api/v1/employees/132/time-off?end=2026-12-31', { credentials: 'include' })
   ```

   The `credentials: 'include'` option reuses the browser's own cookies, so no extra authentication is needed.

5. **Fetch everything in parallel.** Once confirmed, the agent fires all requests at once:

   ```javascript
   Promise.all(employees.map(emp =>
     fetch(`/api/v1/employees/${emp.id}/time-off?end=2026-12-31`,
       { credentials: 'include' })
       .then(r => r.json())
       .then(data => ({ name: emp.name, sickDays: data.sickDaysUsed }))
   ))
   ```

   All the requests go out together and come back in a second or two.

6. **Collect and format.** The agent gathers the structured results and shapes them however you asked — a table, a spreadsheet, a summary, or raw data.

## A worked example

Take a prompt like:

> "Open our HR portal, run through every employee, and hand me a spreadsheet of how many sick days each took over the past year."

Done through the UI, the agent opens 25 profiles one at a time, finds the leave section on each, and reads the number — several minutes of work.

Done through API discovery, the agent opens the first profile, notices the page calls the time-off endpoint, finds the directory endpoint, and fetches all 25 records in parallel — a couple of seconds, plus department and job title come along for free. The output is a complete table that would otherwise have meant clicking through several tabs per person.

## Key techniques

| Technique | Why it helps |
| --- | --- |
| `credentials: 'include'` | Reuses the browser's session cookies, so no separate auth is required |
| `Promise.all()` | Fires every request at once for the big speedup |
| Storing results on `window.__` variables | Carries async fetch results back so the agent can read them on the next `evaluate` |
| `DOMParser` for XML | Handles internal APIs that answer with XML instead of JSON |
| Chunked batches | Keeps large jobs (50+ items) from overwhelming the server |

## Common questions

**How does authentication work?**
Because the agent runs JavaScript inside the page's own context, its `fetch()` calls inherit the browser's cookies and session. If you are logged in, the calls are authenticated automatically — no tokens or keys to manage.

**Does this work with GraphQL?**
Yes. GraphQL apps usually route everything through one `/graphql` endpoint. The agent inspects the network traffic to learn the query shape, then replays it with the right body and variables. The same `credentials: 'include'` pattern applies.

**What about rate limits?**
For hundreds of items the agent splits the work into batches (for example 20–50 at a time) with small pauses between them, to stay under server limits.

**What if the response is XML?**
Some enterprise systems return XML rather than JSON. The agent parses it with the browser's built-in `DOMParser` and pulls values out with `querySelector` and `getAttribute`.

**Can I ask for this pattern explicitly?**
Yes. If you already know a task is repetitive extraction, prompt for it directly — for example, "watch the network calls, find the backing endpoint, and hit it directly rather than paging through the UI" — and the agent will prefer the discovery route.

**What about CORS?**
Not a problem. The JavaScript runs in the page's own origin (via `evaluate`), so every request is same-origin and there are no cross-origin restrictions to work around.

## A note on safety

API discovery reuses the session already loaded in the browser — it does not persist cookies or tokens anywhere. If you want a repeatable, shareable integration built on the endpoint you found, turn it into an [API source](../sources/apis/overview) with a rotatable key or bearer token instead of leaning on the live browser session.
