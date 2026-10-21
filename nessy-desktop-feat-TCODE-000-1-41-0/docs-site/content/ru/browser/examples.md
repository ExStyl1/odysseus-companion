# Примеры и рецепты

Частые browser patterns, описанные с точки зрения агента. На практике вы просто говорите обычным языком, что нужно, а агент выбирает commands `browser_tool` — эти recipes показывают, что происходит внутри.

## Log in and navigate

Агент может войти в web app с вашими credentials и перейти на authenticated page.

```text
"Go to app.example.com, log in with my credentials, and open the Reports page"
```

Under the hood:

1. Он открывает window и загружает login page сайта.
2. Делает `snapshot`, чтобы найти email/password inputs и sign-in button, каждый с reference вроде `@e3`, `@e5`, `@e7`.
3. Использует `fill` на input fields и `click` на button.
4. Ждёт стабилизации page (`wait network-idle`) и затем navigates to target page.

::: tip
Если вы уже logged into site в browser, агент переиспользует эту session — повторный sign-in не нужен.
:::

## Fill a multi-field form

Агент работает с forms, где есть text fields, dropdowns и checkboxes.

```text
"Fill out the support-ticket form on our internal tool: set priority to High,
category to Billing, and describe it as 'Customer charged twice for subscription'"
```

Он snapshots form, сопоставляет каждое field по label, использует `fill` для text и `select` для dropdown values, затем clicks submit.

## Extract data from a page

Используйте `evaluate`, чтобы вытянуть structured data из любой rendered page.

```text
"Open our analytics dashboard and extract the top 10 rows of the summary table"
```

Агент запускает JavaScript прямо в page:

```javascript
Array.from(document.querySelectorAll('table.summary tr'))
  .slice(0, 10)
  .map(row => ({
    metric: row.cells[0].textContent,
    value: row.cells[1].textContent,
  }))
```

Всё, что возвращает snippet, приходит как structured data; агент может оформить это в table, передать в spreadsheet или исследовать дальше.

## Watch network traffic

Посмотрите, какие backend calls делает page — полезно для debugging или поиска internal endpoint.

```text
"Open the dashboard, click Refresh, and show me what API calls it makes"
```

Агент запускает `network`, чтобы перечислить requests страницы, с URL, HTTP method, status code и payload size для каждого. Это starting point для [API discovery](./api-discovery).

## Capture a targeted screenshot

Захватите один element или region вместо whole page через `screenshot-region`.

```text
"Take a screenshot of just the revenue chart on the dashboard"
```

Агент может target capture по:

- **Element reference** — snapshot page, найти `@eN` chart и захватить только element (`screenshot-region --ref @e12`).
- **CSS selector** — target something like `screenshot-region --selector div[data-testid="revenue-chart"]`.
- **Coordinates** — capture fixed pixel region (`screenshot-region 100 200 640 480`).

Чтобы подписать каждый interactive element в current view, `screenshot --annotated` накладывает references `@eN` прямо на image.

## Send keyboard shortcuts

Запускайте app-specific shortcuts через `key`.

```text
"Open the command palette with Cmd+K and search for 'billing'"
```

Агент отправляет combo (`key k meta`) и может использовать любой modifier — Shift, Control, Alt или Meta/Cmd.

## Multi-step workflows

Объединяйте несколько actions в одну job.

```text
"Go to our HR portal, open each team member's profile, and compile their
job titles and departments into a spreadsheet"
```

Когда task проходит по множеству похожих items, агент часто находит более быстрый route — см. [API Discovery](./api-discovery), как он находит internal endpoint и pulls every record concurrently вместо ручного открытия каждого item.

## Tips for best results

- **Уточняйте output.** "Pull each employee's name and email out of the table" лучше, чем "get the data."
- **Скажите, если уже logged in.** Агент пропустит sign-in flow.
- **Опишите сложный layout.** "Look in the second tab, in the Summary section" экономит много поиска.
- **Попросите format.** "Return it as a spreadsheet" или "lay it out as a table" сразу даёт нужную shape.

## Troubleshooting

- **Page not loading.** Агент retries navigation. Если всё равно не получается, проверьте URL и доступность site.
- **Element not found.** Агент делает re-snapshot после navigation. Для dynamically loaded content может понадобиться `wait` или scroll до появления element.
- **Login not working.** CAPTCHAs и multi-factor prompts нельзя автоматизировать. Выполните sign-in сами, затем верните session агенту.
- **Flaky interactions.** Агент делает re-snapshot и retry. Pages с animations могут требовать короткий `wait` между actions.
