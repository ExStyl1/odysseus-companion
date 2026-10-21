# Поиск API

Это browser pattern с самой высокой отдачей. Вместо того чтобы кликать по web UI строка за строкой, агент смотрит, какие backend calls делает page, выводит pattern и затем вызывает эти endpoints напрямую — часто превращая многоминутный click-through в пару секунд.

## Идея

Большинство modern web apps — single-page applications, которые говорят с backend через `fetch()` или XHR. Каждый раз, когда вы открываете employee record, ticket или order, page незаметно обращается к internal API. Эти requests видны в network log, и как только агент понимает форму одного request, он может воспроизвести его для всех items сразу — обходя медленный UI.

::: info
Не обязательно просить об этом по имени. Когда агент замечает, что открывает много похожих items подряд, он часто сам переключается на этот approach.
:::

## Почему это стоит делать

| | Clicking through the UI | Calling the API directly |
| --- | --- | --- |
| Speed per item | 5–10 seconds | roughly 100 milliseconds |
| Parallelism | One at a time | All items at once |
| Data format | Text scraped off the page | Structured JSON or XML |
| Reliability | Breaks when the UI changes | Rides stable API contracts |
| Auth | Already signed in | Reuses the same browser session |

Для request вроде "pull the time-off totals for 25 people" это разница между несколькими минутами кликов и парой секунд parallel calls.

## Как это работает

1. **Interact once.** Агент загружает app и проходит один item обычным способом — ровно настолько, чтобы page отправила API calls.

2. **Inspect the traffic.** Через `network` агент просматривает requests страницы и выделяет REST или GraphQL endpoints, которые возвращают structured data:

   ```text
   GET /api/v1/employees/132/time-off?end=2026-12-31 → 200 (JSON, 1.2KB)
   GET /api/v1/employees/132?fields=department,jobTitle → 200 (JSON, 0.4KB)
   ```

3. **Spot the pattern.** Он распознаёт template — `/api/v1/employees/{id}/time-off` — и теперь знает, как построить request для любого id.

4. **Verify with one call.** Перед масштабированием агент выполняет один `evaluate`, чтобы подтвердить endpoint:

   ```javascript
   fetch('/api/v1/employees/132/time-off?end=2026-12-31', { credentials: 'include' })
   ```

   Option `credentials: 'include'` переиспользует cookies самого browser, поэтому extra authentication не нужна.

5. **Fetch everything in parallel.** После подтверждения агент запускает все requests сразу:

   ```javascript
   Promise.all(employees.map(emp =>
     fetch(`/api/v1/employees/${emp.id}/time-off?end=2026-12-31`,
       { credentials: 'include' })
       .then(r => r.json())
       .then(data => ({ name: emp.name, sickDays: data.sickDaysUsed }))
   ))
   ```

   Все requests уходят вместе и возвращаются за секунду-другую.

6. **Collect and format.** Агент собирает structured results и оформляет их так, как вы просили — table, spreadsheet, summary или raw data.

## Worked example

Возьмём prompt:

> "Open our HR portal, run through every employee, and hand me a spreadsheet of how many sick days each took over the past year."

Через UI агент открывает 25 profiles по одному, находит leave section в каждом и читает number — несколько минут работы.

Через API discovery агент открывает первый profile, замечает call к time-off endpoint, находит directory endpoint и fetches all 25 records in parallel — пара секунд, а department и job title приходят бесплатно. Output — complete table, которая иначе требовала бы перехода по нескольким tabs на person.

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
Поскольку агент запускает JavaScript внутри context самой page, его `fetch()` calls наследуют browser cookies и session. Если вы logged in, calls authenticated automatically — tokens или keys не нужны.

**Does this work with GraphQL?**
Да. GraphQL apps обычно отправляют всё через один endpoint `/graphql`. Агент смотрит network traffic, чтобы узнать query shape, затем replay с нужным body и variables. Тот же pattern `credentials: 'include'` применим.

**What about rate limits?**
Для сотен items агент делит работу на batches (например по 20–50) с небольшими паузами, чтобы не выйти за server limits.

**What if the response is XML?**
Некоторые enterprise systems возвращают XML вместо JSON. Агент разбирает его встроенным browser `DOMParser` и достаёт значения через `querySelector` и `getAttribute`.

**Can I ask for this pattern explicitly?**
Да. Если вы уже знаете, что задача — repetitive extraction, попросите прямо: "watch the network calls, find the backing endpoint, and hit it directly rather than paging through the UI" — и агент предпочтёт discovery route.

**What about CORS?**
Не проблема. JavaScript запускается в own origin страницы (через `evaluate`), поэтому каждый request same-origin и cross-origin restrictions не мешают.

## Safety note

API discovery переиспользует session, уже загруженную в browser, — он не сохраняет cookies или tokens. Если нужен repeatable, shareable integration на найденном endpoint, превратите его в [API source](../sources/apis/overview) с rotatable key или bearer token вместо опоры на live browser session.
