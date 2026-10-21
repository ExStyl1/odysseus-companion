# Введение

Nessy Desktop — внутренний desktop client T-Bank для работы с агентами. Он соединяет агента, способного писать код, с inbox постоянных сессий, поэтому задачи по разработке, исследованию и операционной рутине могут идти параллельно, сохранять полную историю и возобновляться ровно с места остановки. Из коробки приложение работает с внутренним Nessy Gateway; входы по подписке Claude и ChatGPT остаются доступными как optional connections.

## Зачем desktop app

### Сессии живут в inbox

Диалоги здесь не похожи на одноразовый terminal scrollback. У каждой сессии есть статус, optional labels и полная история, а inbox группирует сессии так же, как почтовый клиент группирует сообщения. Когда агент готовит план, вы читаете его в документном представлении и подтверждаете или перенаправляете до запуска действий — это ближе к ревью предложения коллеги, чем к присмотру за shell.

### Подключение к чему угодно

**Источники** — способ вывести агента за пределы окна чата:

| Тип источника | Типичные примеры | Что это даёт |
| ------------- | ---------------- | ------------ |
| MCP servers | Issue trackers, wikis, internal platforms | Интеграции на уровне tools, с auth на стороне каждого server |
| REST APIs | Любой HTTP service с API description | Агент читает spec и сам выполняет requests |
| Локальные папки | Code checkouts, notes vaults | Прямое чтение и редактирование файлов на вашей машине |

Одна сессия может свободно смешивать источники: взять ticket через MCP server, вызвать внутренний REST endpoint, затем отредактировать файлы в локальном checkout — всё в одном thread.

### Несколько задач одновременно

Сессии выполняются независимо. Запустите долгий refactor, ответьте на быстрый вопрос в другой workspace и вернитесь позже; фоновые сессии продолжают работать, а inbox показывает, какие из них ждут вас.

### План перед выполнением

Сессию можно начать в **Plan** — read-only режиме, где агент исследует и пишет черновик, ничего не меняя. Когда план выглядит правильно, переключитесь в **Manual**, **Accept edits**, **Auto** или **Bypass permissions** и продолжайте с нужным уровнем autonomy. Переключайте режимы через **Shift+Tab** или из chat input.

### Долговечная запись

Поскольку сессии сохраняются, рассуждения за изменением остаются рядом с ним: что пробовали, что отвергли и почему итоговая форма победила. Повторное открытие старой сессии сразу возвращает этот контекст.

::: info
Общий доступ к чату публикует снимок со скрытыми секретами в t-artifacts после карточки подтверждения — см. [Общий доступ](/ru/go-further/sharing).
:::

### Server и CLI включены

Движок приложения также работает headless. Запустите [server](../server/headless) из repository checkout и управляйте им через [CLI](../reference/cli) для scripted или remote use. В v1 prebuilt server distribution не публикуется, поэтому этот путь пока source-only.

### Конфигурация, которую может менять агент

Themes, statuses, skills и permission rules — обычные файлы под `~/.nessy-agent`. Можно попросить агента изменить их вместо ручного поиска в settings screens.

| Что | Формат | Область |
| --- | ------ | ------- |
| [**Skills**](../skills/overview) | Папка с entry point `SKILL.md` | Вызываются mention-ом или применяются автоматически |
| [**Themes**](../go-further/themes) | Semantic color tokens | App-wide или per workspace, light и dark |
| [**Statuses**](../statuses/overview) | Workflow-state config | Названия, colors, icons, inbox grouping |
| [**Permissions**](../core-concepts/permissions) | Layered rules | App, затем workspace, затем source |

## Доступ к моделям

### Nessy Gateway (по умолчанию)

First-run setup предварительно выбирает внутренний gateway, настроенный как OpenAI-compatible `pi_compat` connection:

| Настройка | Значение |
| --------- | -------- |
| Chat endpoint | `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1` |
| Models endpoint | `https://code-completion-nestor.tcsbank.ru/api/v1/cli/models` |
| Auth header | `Nestor-Token: <JWT>` |
| Sign-in | One-click через корпоративный `dp` auth flow; полученный JWT кешируется в `~/.nessy/dp_auth_creds.json` |

Список моделей gateway автоматически обновляется при старте приложения; per-model overrides, сделанные в connection config, сохраняются после refresh. Текущий lineup:

| Model ID | Alias | Роль |
| -------- | ----- | ---- |
| `tgpt/deepseek-v4-flash-0731` | `coder` | Модель для кода по умолчанию — строка, которую шлюз помечает алиасом `coder` (и флагом default, когда он есть); приложение читает список моделей со шлюза при старте и следует этому алиасу, поэтому id может смениться без релиза приложения (предыдущая coder-модель, сборка Qwen 3.5, отставлена шлюзом в сентябре 2026) |
| `tgpt/qwen36-35b-a3b-fp8` | `fast` | Лёгкая модель для быстрых и utility turns |

См. [LLM Connections](../reference/config/llm-connections) для полного формата connection.

### Optional connections

Default build также предлагает:

- **Nessy · Codex agent** — вход в один клик через gateway; сессии идут на bundled Codex harness (`codex-app-server`) против Nessy Gateway через локальный adapter. См. [Codex (Nessy Gateway)](../reference/config/llm-connections#codex-nessy-gateway).
- **Nessy · Claude Code agent** — вход в один клик через gateway, без Anthropic account; сессии идут на bundled Claude Agent SDK против Nessy Gateway через локальный translation adapter. См. [Claude Code (Nessy Gateway)](../reference/config/llm-connections#claude-code-nessy-gateway).
- **Custom runtime endpoint** — с 1.26.0 единственный вход для персонального ключа (отдельная карточка «API key» слита в неё). Выберите runtime — Pi agent, Claude Code или Codex — вставьте ключ и получите список моделей с эндпоинта; на арме Pi вместо custom endpoint доступен provider preset Anthropic или OpenAI. См. [Custom runtime endpoints](../reference/config/llm-connections#custom-runtime-endpoints).

За build-time provider flags (в default build выключены):

- **Claude Pro/Max** — OAuth sign-in; сессии идут через bundled Claude Agent SDK.
- **ChatGPT Plus (Pi)** — вход по подписке ChatGPT; сессии идут через агента Pi.
- **ChatGPT (Codex)** — тот же вход ChatGPT; сессии запускают bundled Codex harness на вашей подписке. См. [ChatGPT (Codex)](../reference/config/llm-connections#chatgpt-codex).
- **Local model** — Ollama или другой локальный OpenAI-compatible server.

GitHub Copilot sign-in, Slack и Microsoft OAuth sources, а также Sentry telemetry удалены из этого fork и недоступны.

## Nessy Desktop и Claude Code

| Аспект | Claude Code | Nessy Desktop |
| ------ | ----------- | ------------- |
| **Интерфейс** | Terminal CLI | Desktop app с session inbox |
| **Доступ к моделям** | Anthropic accounts | Nessy Gateway по умолчанию, плюс Claude, ChatGPT и API-key connections |
| **Источники данных** | MCP servers | MCP servers, REST APIs и локальные папки |
| **Организация сессий** | Флаги `-c` / `--resume` | Inbox со статусами и labels |
| **Конфигурация** | Per-project `.claude/` | Несколько изолированных workspaces под `~/.nessy-agent` |
| **Разрешения** | Фиксированное поведение по режимам | Шесть режимов Claude Code и [rules](../core-concepts/permissions), layered per workspace and source |
| **Remote use** | SSH на машину | [Headless server](../server/headless) с desktop и CLI clients (source-only в v1) |

Когда сессия использует Claude connection, Nessy Desktop запускает тот же Claude Agent SDK, на котором работает Claude Code, поэтому встроенный tool set (Read, Edit, Write, Bash, Glob, Grep), MCP wiring и формат skills ведут себя так, как ожидают пользователи Claude Code. Connection **Nessy · Claude Code agent** — в default build — ставит тот же харнесс на модели Nessy Gateway, без Anthropic account, а card **Nessy · Codex agent** делает то же с Codex harness. Остальные gateway и API-key connections идут через Pi backend.

## Ключевые понятия

[**Источники**](../sources/overview) добавляют к сессии внешние возможности — MCP server, REST API или папку на диске. Включайте только то, что нужно задаче.

[**Workspaces**](../go-further/workspaces) изолируют sources, skills, statuses, labels, preferences и session history друг от друга. Используйте отдельную workspace на проект или контекст.

[**Permission modes**](../core-concepts/permissions) ограничивают, что агент может делать:

| Режим | Config value | Что разрешает |
| ----- | ------------ | ------------- |
| **Don't ask** («Не спрашивать») | `dontAsk` | Никогда не спрашивает; выполняет только заранее разрешённое, остальное запрещает |
| **Plan** | `plan` | Read-only investigation, при желании с планом в конце; пишет только план и папку data этой session |
| **Manual** | `default` | Останавливается для approval на risky actions |
| **Accept edits** | `acceptEdits` | Авто-принимает file edits внутри session roots, но спрашивает про другие side effects |
| **Auto** | `auto` | Разрешает low-risk work; borderline actions проверяет судья безопасности |
| **Bypass permissions** | `bypassPermissions` | Автономные edits и commands без prompts |

Старые конфигурации с прежними написаниями (`safe`, `ask`, `allow-all`, …) продолжают работать — это постоянные aliases режимов выше. Собственный режим Nessy Desktop Explore (`explore`) с версии 1.41.0 упразднён и открывается как Plan.

[**Sessions**](../core-concepts/conversations) хранят диалог вместе с выбранной model, permission mode, status, labels и selected sources.

[**Skills**](../skills/overview) — переиспользуемые папки с инструкциями: review checklist, release routine и другие процессы, которые агент загружает по запросу.

[**Automations**](../automations/overview) запускают prompts или commands по schedules и app events, чтобы routine follow-ups стартовали без ручного prompting.

## Происхождение

Nessy Desktop — внутренний fork upstream OSS codebase (Apache 2.0), rebranded и направленный на internal infrastructure: configuration живёт в `~/.nessy-agent`, deep links используют схему `nessy://`.

## Дальше

- [Установите Nessy Desktop](installation) — one-line install из internal release feed.
- [Добавьте источники](../sources/overview) — подключите MCP servers, APIs и локальные папки.
- [Проверьте LLM connections](../reference/config/llm-connections) — детали gateway и альтернативы.
