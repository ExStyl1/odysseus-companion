# Браузер

Nessy Desktop поставляется с Chromium window, которым агент может управлять от вашего имени. Он открывает URLs, читает page, clicks and types, запускает JavaScript, смотрит network traffic и делает screenshots — весь loop происходит внутри диалога, поэтому результаты не нужно копировать туда-сюда.

## Когда использовать browser

Не каждая web task подходит для browser. Быстрый ориентир:

Хорошо подходит для browser:

- Разовые задачи, где reusable integration была бы избыточной.
- Pure-UI flows для services без API.
- Ситуации, где source ещё не настроен, а ответ нужен сейчас.
- Извлечение данных из rendered page (scraping, table extraction).
- Заполнение forms или прохождение multi-step wizard.

Лучше обрабатывать source:

- Всё, что будет запускаться по schedule или часто повторяться.
- Team-wide reporting и shared automation.
- Workflows, которым нужен стабильный programmatic contract.
- Случаи, где для service уже есть [API](../sources/apis/overview) или [MCP server](../sources/mcp-servers/overview).

## Interaction loop

Любая browser task, какой бы сложной она ни была, строится из одного цикла:

1. **Open a window** — агент открывает Chromium window в background или переиспользует уже открытое (`open`, `focus`).
2. **Navigate** — загружает URL, включая страницы, где вы уже signed in (`navigate <url>`).
3. **Inspect** — агент делает `snapshot`, structured accessibility tree, где каждый interactive element получает короткую reference вроде `@e1`, `@e12`. Также он может выполнить `find <keyword>`, чтобы найти конкретный control.
4. **Act** — по этим references он clicks, types, selects options, scrolls и sends key presses.
5. **Read the result** — извлекает structured data через `evaluate`, делает `screenshot` или выводит recent `network` requests, чтобы подтвердить, что произошло.

## Что умеет агент

Все browser actions идут через одну command `browser_tool`, invoked CLI-style. Она доступна в сессиях Pi и Claude Code; сессии Codex браузером не управляют. Основные возможности:

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

Commands можно объединять в один call через semicolons (`fill @e1 a; fill @e2 b; click @e3`); batch останавливается после navigating command, потому что page state может измениться под ним. Array form (`["evaluate", "var x = 1; x + 2"]`) сохраняет semicolons, tabs и newlines внутри arguments verbatim.

Кавычки группируют аргумент, только когда открывают его: `fill @e5 "Hello world"` вводит `Hello world`, а `fill @e5 Don't do this` вводит апостроф как есть. Кавычка посреди слова остаётся текстом, но по-прежнему защищает точки с запятой внутри себя, поэтому селектор вроде `div[data-x='a;b']` работает без кавычек, а `\;` даёт буквальную точку с запятой. Аргумент, чья открывающая кавычка так и не закрылась, отклоняется до того, как что-либо выполнится. Проверка разрешений читает команду по тем же правилам, что и браузер, который её выполняет, поэтому batch не может выглядеть для одного read-only, а для другого — действием.

Аннотированный скриншот подписывает только видимые на экране элементы и перечисляет не больше 50 из них, по одной короткой строке, чтобы снимок не заваливал переписку.

## Permissions

Browser tools доступны в каждом permission mode, включая read-only Plan mode: там команды, которые только читают страницу, выполняются свободно, а команда, меняющая страницу или состояние браузера, сначала спрашивает. Агент может browse, snapshot и extract без escalation в higher mode. См. [Permissions](../core-concepts/permissions), чтобы понять, как работают modes.

::: info
Перед первым browser action в session агент загружает короткий usage guide для этих tools, поэтому на самом первом call может быть brief pause. Это ожидаемо и помогает агенту не misusing commands.
:::

## Пароли

Когда агент заполняет поле пароля — поле ввода пароля или поле, которое страница помечает как пароль, в том числе внутри shadow DOM, — результат называет только поле и число введённых символов, а при вводе или вставке в такое поле вместо текста показывается заполнитель. Сохранённая переписка хранит заполнитель и в результате, и в записанной команде, а карточка, которую видите вы, скрывается так же, как только приходит результат. Просите агента вводить пароли командой `fill`.

Что это не покрывает, говорим прямо: модель видела значение, которое ввела; хук `PostToolUse` получает исходную команду; карточка разрешения в режиме Ask показывает полную команду в момент запроса; ваше собственное сообщение в чате хранится так, как вы его написали.

## Window lifecycle

Browser window остаётся живым между turns внутри session. Когда агент закончил, он может завершить работу окна одним из трёх способов:

| Action | What happens | When to use |
| --- | --- | --- |
| `close` | Window is destroyed; all page state is lost | Task is fully done and the browser is no longer needed |
| `release` | The agent's control overlay is dismissed; the window stays open for you | Agent is done but you want to keep browsing |
| `hide` | Window is hidden but kept in memory | Temporarily done; the agent may need it again shortly |

Закрытие окна через OS window control **hides** его вместо destroy, поэтому агент может мгновенно вернуть его.

## Скрытые окна и окна входа

На страницах, которыми приложению можно управлять через отладочный канал браузера, клики, нажатия клавиш и перетаскивания агента доходят до страницы, даже когда окно скрыто или находится под другим; в остальных случаях используется обычный ввод. Если элемент, по которому агент хочет кликнуть, чем-то закрыт — баннером, оверлеем, — клик заменяется кликом скриптом по самому элементу, и результат говорит об этом и называет, что закрывало элемент. Выбор варианта в выпадающем списке ищет его по значению, подписи или видимому тексту, а заполнение поля работает и со страницами, которые отслеживают ввод по-своему (например, формы на React).

Все окна браузера используют общий набор cookies. Если страница просит открыть окно входа — провайдера учётных записей или страницу логина, — а в другом окне браузера того же рабочего пространства этот вход уже открыт, второе окно не открывается: открытое выводится на передний план для вас, а агенту сообщают дождаться завершения входа и затем перезагрузить свою страницу. О всплывающем окне, которое открылось по клику, агенту тоже сообщают: вы видите его и можете им пользоваться, но агент управлять им не может.

## Windows scoped to workspace

Каждое browser window принадлежит [workspace](../go-further/workspaces), которая его открыла. Переключитесь в другую workspace — toolbar и tab strip покажут только windows этой workspace, а windows других workspaces останутся quietly running в background. Окно, которое вы открываете вручную из top bar, следует тому же правилу — оно привязано к workspace, active на момент открытия.

## Browser на remote workspaces

Когда вы подключаетесь к [remote workspace](../server/headless) из desktop app, агент на server не запускает собственный headless Chromium. Вместо этого он управляет **вашим локальным browser**, вызывая desktop client обратно по тому же WebSocket connection. Окно открывается на вашей машине, уже signed in с вашими cookies и extensions.

::: info
Remote browsing требует desktop app как client. Browser tool недоступен, когда единственный connected client — CLI.
:::

На практике это значит:

- Окно открывается на вашем компьютере, а не на server.
- Ваши существующие logins и cookies переиспользуются, поэтому на remote side не нужен second sign-in.
- Если desktop client отключится посреди task, следующее browser action на server вернёт prompt "client disconnected" failure вместо бесконечного ожидания.
- Переход между workspaces не вырывает window из remote session; каждое window остаётся bound к workspace, которая его запустила.

### Guard для remote JavaScript

`evaluate` выполняет переданный script на live page. Так как эта page находится на **вашей** машине под **вашими** cookies, desktop client ставит remote script execution за local switch:

| Setting | Default | Effect when disabled |
| --- | --- | --- |
| `allowRemoteEvaluate` | `true` | Remote `evaluate` calls are rejected locally with `BROWSER_REMOTE_EVALUATE_BLOCKED`. Navigation, clicks, form fills, and screenshots keep working. |

Оставляйте его выключенным, когда remote workspace, к которой вы подключаетесь, не полностью trusted. Задайте `"allowRemoteEvaluate": false` в `~/.nessy-agent/config.json`. Guard действует только на agents, running on remote servers — local sessions не затрагиваются. Uploading files через remote bridge полностью disabled, потому что source file жил бы на remote host и не может быть передан вашему local browser.
