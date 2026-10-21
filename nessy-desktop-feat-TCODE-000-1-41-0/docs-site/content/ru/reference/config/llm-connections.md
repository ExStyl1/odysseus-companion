# LLM Connections

LLM connection — это именованная provider configuration. Можно добавить
несколько connections, переключаться между ними, а workspace может закрепить
свой default. Каждая session фиксирует connection после первого message.
Connections хранятся в [config file](config-file); их secrets находятся в
[credential store](credentials).

Nessy Desktop направляет каждую connection через один из четырёх backends:
встроенный Nessy Gateway и другие custom endpoints (Pi backend), Claude
subscription или Anthropic API key (Claude Agent SDK), вход по подписке ChatGPT
(Pi backend), либо bundled Codex harness (`codex-app-server`), который тоже
умеет работать на подписке ChatGPT — см. [ChatGPT (Codex)](#chatgpt-codex). Два coding
runtime включены в default build: [Claude Code runtime](#claude-code-nessy-gateway)
направляет Claude Agent SDK на Nessy Gateway (или на
[ваш собственный endpoint](#custom-runtime-endpoints)), а
[Codex runtime](#codex-nessy-gateway) делает то же с Codex harness.

## Расположение

```
~/.nessy-agent/config.json
```

Connections — это массив `llmConnections` в этом файле.

## Как выбирается connection

Для новой session connection выбирается в таком порядке:

1. **Session connection** — закрепляется после первого message.
2. **Workspace default** — `defaults.defaultLlmConnection` у workspace.
3. **Global default** — `defaultLlmConnection` в `config.json`.
4. **First connection** в списке как fallback.

::: info
Session фиксирует connection после первого message. Чтобы использовать другую
connection, начните новую session.
:::

### Endpoint решает connection

Model calls session уходят на endpoint, который называет её connection: base URL
connection, loopback adapter card [Claude Code runtime](#claude-code-nessy-gateway)
или — для connection без собственного endpoint (**Anthropic (API key)** без
custom endpoint, **Claude Pro/Max**) — собственный адрес вендора,
`https://api.anthropic.com`. В Claude session ничто вне connection его не
сдвигает:

- **`ANTHROPIC_BASE_URL` в окружении, с которым запущено приложение** (запуск из
  терминала или headless `nessy-server`), игнорируется — одинаково на первом
  turn и после сохранения любой connection. **Settings → Диагностика настроек**
  показывает его по имени, никогда по значению. Значение, экспортированное только
  в вашем login shell, не доходит до приложения, открытого из Dock или Finder,
  поэтому там оно и не показывается.
- **`env.ANTHROPIC_BASE_URL` в Claude settings file** (пользовательский
  `settings.json` Workspace или `.claude/settings.json` либо
  `.claude/settings.local.json` репозитория) тоже игнорируется. Чат один раз
  сообщает, какой файл его задал, а Settings → Диагностика настроек показывает
  этот файл, как только стартовала session, которая его загружает, и до
  перезапуска приложения. То же имя в `env` у `--settings`
  (`NESSY_CLAUDE_SETTINGS`) игнорируется, и чат об этом сообщает; остальные
  записи его `env` по-прежнему применяются.
- **Переключатели provider и first-party flag** в `env` settings file
  игнорируются так же. Переключатели provider (`CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`,
  `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_GATEWAY`) держатся выключенными,
  так что файл не может перевести session на Bedrock, Vertex, gateway или другой
  provider. Его `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` не заставляет Claude
  Code считать endpoint connection собственным endpoint Anthropic. Чат один раз
  называет файл, а Settings → Диагностика настроек показывает его по пути и
  имени настройки (например, `env.CLAUDE_CODE_USE_VERTEX`), никогда по
  значению. В `env` у `--settings` эти имена тоже игнорируются, и об этом
  сообщает только чат.
- **Claude settings, управляемые организацией** (`managed-settings.json`),
  не трогаются и по-прежнему имеют приоритет.

Процессы, которые запускает Claude session (её shell commands, hooks и stdio MCP
servers), видят в `ANTHROPIC_BASE_URL` тот же endpoint: собственный адрес
connection или `https://api.anthropic.com` у connection без него — никогда не
значение из окружения запуска и никогда не пустое, так что скрипт, который
пользуется Anthropic SDK внутри session, получает рабочий адрес. Поэтому у
connection без собственного endpoint `/status` Claude Code показывает
`https://api.anthropic.com` как свой base URL. Чтобы использовать другой
endpoint, задайте base URL в самой connection.

### Credential решает проект

Connection решает, **куда** уходят requests (endpoint и provider, см. выше).
Собственная конфигурация доверенного проекта или Workspace может решить, **каким
credential** они подписываются, — ровно настолько, насколько это позволяет сам
runtime, и приложение всегда называет файл, который это сделал:

| Runtime | Может ли конфигурация проекта выбрать credential? |
| --- | --- |
| Claude | Да, так, как это позволяет Claude Code. `env.ANTHROPIC_AUTH_TOKEN` или `env.ANTHROPIC_API_KEY` в загруженном settings file используется для session: token отправляется как bearer рядом с key connection, key его заменяет. `apiKeyHelper` и `env.CLAUDE_CODE_OAUTH_TOKEN` из файла стоят ниже обоих по собственному порядку аутентификации Claude Code: каждый заменяет вход Claude Pro/Max; рядом с API key OAuth token не используется, а команда `apiKeyHelper` всё равно запускается при старте session, и её вывод отправляется как bearer. Чат называет файл и настройку, а Settings → Диагностика настроек показывает его в разделе **Settings-file credentials in use** — только имена, никогда значение. Через локальный adapter приложения (**Claude Code (Nessy Gateway)** или card Claude Code runtime с custom endpoint) такой credential доходит только до adapter, а тот подписывает каждый request credential connection. Уберите его из файла, чтобы использовать credential connection. |
| Codex | Нет. Codex сам отбрасывает `model_provider`, `model_providers` и `profile` из `.codex/config.toml` проекта, так что репозиторий не может ни выбрать другой provider, ни дать provider приложения собственный key или token; используется credential connection. |
| Pi | Нет. Pi sessions получают credential только из connection; приложение не даёт Pi файла models и не читает для них settings files Pi. |

У недоверенного репозитория его Claude settings files не загружаются, поэтому
из него ничего не используется и не показывается.

## Connection schema

```json
{
  "slug": "nessy-gateway",
  "name": "Nessy Gateway",
  "providerType": "pi_compat",
  "piAuthProvider": "openai",
  "authType": "bearer_token",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Fields

| Field               | Required | Description                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `slug`              | Yes      | URL-safe identifier; also the key under which credentials are stored                               |
| `name`              | Yes      | Display name shown in the UI                                                                        |
| `providerType`      | Yes      | Backend to use (see below)                                                                          |
| `authType`          | Yes      | Authentication mechanism (see below)                                                                |
| `baseUrl`           | No       | Base URL — required for `pi_compat`, optional override otherwise                                    |
| `piAuthProvider`    | No       | Pi provider name (for example `openai`, `anthropic`); relevant to `pi`/`pi_compat` connections     |
| `codexModelProvider`| No       | Собственный provider Codex, куда `codex-runtime` connection отправляет turns вместо локального adapter: `openai` на card [ChatGPT (Codex)](#chatgpt-codex) |
| `customEndpoint`    | No       | Custom endpoint protocol config: `api` (wire format) and optional `supportsImages`                 |
| `models`            | No       | Explicit model list — strings, or objects with `contextWindow` / `supportsImages` overrides        |
| `defaultModel`      | No       | Default model for this connection                                                                   |
| `modelSelectionMode`| No       | `automaticallySyncedFromProvider` or `userDefined3Tier`                                             |
| `midStreamBehavior` | No       | `"steer"` or `"queue"`; see [Mid-stream behaviour](#mid-stream-behaviour)                           |
| `createdAt`         | Yes      | Creation time, Unix milliseconds                                                                    |
| `lastUsedAt`        | No       | Last-used time, Unix milliseconds                                                                   |

## providerType values

| Value       | Backend                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `anthropic` | Direct Anthropic API via the Claude Agent SDK                              |
| `pi`        | Pi unified API for provider-backed routes (например card ChatGPT Plus)     |
| `pi_compat` | Pi with a custom endpoint — the Nessy Gateway, Ollama, self-hosted models  |
| `claude-runtime` | Claude Agent SDK pointed at a non-Anthropic endpoint through a local translation adapter — the [Claude Code runtime](#claude-code-nessy-gateway) |
| `codex-runtime` | Bundled `codex-app-server` harness, направленный на Nessy Gateway или custom endpoint через локальный Responses-API adapter — [Codex runtime](#codex-nessy-gateway), — или на собственный provider Codex на вашей подписке ChatGPT ([ChatGPT (Codex)](#chatgpt-codex)) |
| `nestor-cloud-agent` | Native Nestor cloud code-agent по A2A 1.0 на `/api/v2/code-agent/a2a` (Nessy Gateway sign-in) |

### Nestor Cloud composer modes

Nestor Cloud composer controls работают от capabilities. При startup session
Nessy Desktop читает A2A AgentCard cloud agent, достаёт advertised
`agent-settings` mode enum и публикует эти modes в renderer. Затем mode picker,
slash menu и Shift+Tab cycle используют remote mode IDs при отправке turns.

Если AgentCard нельзя прочитать или extension отсутствует, session возвращается
к built-in Nestor Cloud contract: **Plan** и **Act**. Fallback не добавляет
network I/O в synchronous config loading.

### Nestor Cloud local tools

Nestor Cloud запускает agent loop удаленно через A2A, но file, shell, search и
notebook actions по-прежнему выполняются локально в Nessy Desktop. Remote tool
calls адаптируются в shared local tool runtime, поэтому path scoping,
permissions, checkpoints и command execution остаются на desktop side, а не
переезжают в cloud agent.

Pi-backed local sessions используют тот же runtime для built-in file и shell
tools, сохраняя существующие Pi tool names, schemas, approval prompts,
workflow tools и subagent behavior. Claude и Codex provider paths отделены и не
используют этот runtime, пока отдельная feature явно их туда не подключит.

::: info
Older configs могут содержать legacy provider values (например `bedrock`,
`vertex` или `anthropic_compat`). Они мигрируют к текущему набору при startup.
:::

## authType values

| Value                   | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `api_key`               | API key only, fixed endpoint                    |
| `api_key_with_endpoint` | API key plus a custom endpoint URL              |
| `bearer_token`          | Single bearer token (distinct header from key)  |
| `oauth`                 | Browser OAuth login (Claude subscription, обе ChatGPT cards) |
| `iam_credentials`       | AWS-style access key + secret + region          |
| `service_account_file`  | GCP service-account JSON file                    |
| `environment`           | Auto-detect from environment variables          |
| `none`                  | No authentication (for example local Ollama)    |

## Nessy Gateway

Встроенный Nessy Gateway — это `pi_compat` connection с `piAuthProvider`,
установленным в `openai`:

- **Chat endpoint**:
  `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`
- **Models endpoint**:
  `https://code-completion-nestor.tcsbank.ru/api/v1/cli/models`
- **Auth header on the gateway path**: `Nestor-Token` с JWT. Исходящий
  `Authorization: Bearer <jwt>` переписывается в `Nestor-Token` **только** для
  URLs, начинающихся с `https://code-completion-nestor.tcsbank.ru/api/v1/cli/`.
  Любой другой endpoint — включая другой path на том же host — сохраняет
  стандартную семантику `Authorization: Bearer`.
- **Вход в один клик**: gateway card выполняет вход без формы. Приложение
  запускает корпоративный `dp` auth flow, обменивает token на gateway JWT и
  создаёт connection автоматически. Credentials кэшируются в
  `~/.nessy/dp_auth_creds.json` (общий файл с nessy-cli); всё за пределами
  auth-модуля считает этот файл read-only.
- **Model refresh**: список gateway models обновляется при startup из
  `/models` endpoint. Server-provided models приходят с aliases (например
  `coder`, `fast`) и server default; ваши per-model overrides сохраняются между
  refreshes.
- **Context window**: built-in Gateway Qwen models используют 262,144-token
  context window. `/models` endpoint не всегда сообщает это value, поэтому
  Nessy Desktop применяет known window для этих internal model IDs и обновляет
  старые persisted 131,072-token values при startup.
- **Настройки генерации, которые публикует каталог, и что с ними происходит.**
  Измерено 2026-09-13: каждая строка `/models` несёт объект `sampling_params`
  (temperature, `top_p`, иногда `top_k`), а строка default `coder` — ещё и
  `reasoning` с рекомендованным effort. **Nessy Desktop читает оба поля и
  применяет их как значения по умолчанию, которые вы всегда можете
  переопределить.**
  - **Sampling** — опубликованные `temperature`, `top_p` и любой другой ключ из
    этого объекта применяются к этой модели, если ваш запрос не задал их сам.
    Раньше каждая модель шлюза получала фиксированные `temperature: 0.7` и
    `top_p: 0.8` независимо от своей строки каталога, а `top_k` не доходил до
    шлюза вообще.
  - **Reasoning effort** — рекомендованный effort подставляется только тогда,
    когда ваш runtime просит reasoning и не называет уровень. Он никогда не
    перебивает выбранный вами уровень и никогда не включает thinking, если вы его
    выключили. На практике это значит, что codex runtime подхватывает
    рекомендацию, когда effort не задан, а Claude runtime почти всегда шлёт свой
    собственный, выведенный из вашей настройки thinking.
  - **Чего это стоит.** Thinking не бесплатен: на измеренном плече один и тот же
    промпт занял 0.9 с без ключа effort и 12 с с `low`, плюс reasoning-токены.
    Измерение, которое снимает главный страх, тоже в силе: ход без ключа effort
    не думает вообще (измерено дважды на модели по умолчанию — ноль
    reasoning-токенов), то есть ничего и не тарифицировалось молча по высокому
    effort, а плоский ключ `reasoning_effort` и вложенный объект
    `reasoning.effort` одинаково включают thinking и возвращают идентичный usage.
  - `extra_body` этот шлюз не публикует ни в одной строке, так что читать нечего.

## Claude Code (Nessy Gateway)

Вторая gateway card, **Nessy · Claude Code agent**, запускает bundled Claude
Agent SDK — тот самый харнесс, что стоит за Claude Code — против того же
внутреннего gateway. Она создаёт `claude-runtime` connection (slug
`claude-gateway`, display name `Claude Code (Nessy Gateway)`) с уже заполненными
gateway endpoint и model catalog.

- **Build flag**: `NESSY_FEATURE_CLAUDE_RUNTIME`, **on** в default build
  начиная с 1.19.0 — card и bundled Claude SDK native binary входят в сборку,
  если флаг явно не выставлен в `0` (явный `NESSY_FEATURE_PROVIDER_CLAUDE=1`
  всё равно кладёт binary — subscription card без него не работает).
- **Sign-in**: один клик, без формы — тот же корпоративный `dp` flow и тот же
  кэшированный JWT, что и у Nessy Gateway card выше. Anthropic account не нужен.
- **Как это доходит до gateway**: каждая session поднимает loopback translation
  adapter и направляет на него SDK
  (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`). Adapter говорит с SDK в
  формате Anthropic Messages, а вверх по течению — собственным API gateway.
  `Nestor-Token` добавляется, только если base URL connection — это
  проверенный gateway URL; любой другой endpoint сохраняет стандартную
  семантику `Authorization: Bearer`. Adapter живёт в рамках session и
  останавливается вместе с ней.
- **Models**: тот же gateway catalog, что и у Pi-backed card. Utility turns —
  session titles, web-page summaries — резолвятся через gateway alias `fast`, а
  не через flagship, и продолжают это делать после того, как startup model
  refresh переупорядочит catalog. Собственные вызовы агента к побочной модели
  (`call_llm`) тоже идут на модель, которую card обслуживает: вызов без модели
  или с моделью Claude, которой нет в списке card, идёт на ту же модель `fast`,
  а вызов сообщает, какая модель ответила. Если же назвать в
  `call_llm` один из собственных id моделей card, вызов идёт на эту
  модель.
- **Чего в этом релизе нет**: image attachments не передаются на
  `claude-runtime` connection, а **thinking budget не отправляется вовсе**.
  Budget резолвится по model id, а gateway-модель не является Claude-моделью,
  поэтому runtime получает «thinking выключен» ещё до того, как будет прочитан
  уровень: контрол thinking level и ключевое слово `ultrathink` на этой card не
  меняют ничего. Измерено вживую на packaged build 2026-09-12: child
  запускается с `--thinking disabled` при любом выбранном уровне. Reasoning
  block в диалоге всё равно появляется — это собственные рассуждения
  gateway-модели, превращённые loopback adapter в Anthropic thinking block;
  отсюда и нулевой счётчик thinking tokens рядом с ним.

::: info
Sessions на этой connection используют собственный tool set Claude Agent SDK,
его MCP wiring и обработку skills — Pi tool names и workflow tools к ним не
применяются.
:::

## Codex (Nessy Gateway)

Третья gateway card, **Nessy · Codex agent**, запускает bundled Codex harness
(`codex-app-server` — движок Codex CLI от OpenAI) против того же внутреннего
gateway. Она создаёт `codex-runtime` connection (slug `codex-gateway`) с уже
заполненными gateway endpoint и model catalog.

- **Build flag**: `NESSY_FEATURE_CODEX_RUNTIME`, **on** в default build начиная
  с 1.19.0 — card и bundled `codex-app-server` binary входят в сборку, если
  флаг явно не выставлен в `0`.
- **Sign-in**: один клик, без формы — тот же корпоративный `dp` flow и тот же
  кэшированный JWT, что и у остальных gateway cards. OpenAI account не нужен.
- **Как это доходит до gateway**: каждая session поднимает loopback adapter,
  который говорит с `codex-app-server` в формате Responses API, а вверх по
  течению — chat/completions API самого gateway. `Nestor-Token` добавляется,
  только если base URL connection — это проверенный gateway URL; любой другой
  endpoint сохраняет стандартную семантику `Authorization: Bearer`. Adapter
  держит зависший upstream честным: heartbeats закрывают паузы посреди stream,
  а stream, оборвавшийся до завершения, после пяти reconnect-попыток
  превращается в ошибку — никогда в тихо обрезанный turn.
- **Tools**: sessions используют собственный sandboxed tool set Codex harness
  (shell-команды, patches); Pi tool names и workflow tools к ним не применяются.
- **Integrity**: bundled binary проверяется против hash, закреплённого в
  приложении, ещё до запуска, и session откажется стартовать, вместо того чтобы
  запустить не совпавший binary. Code signing настроено так, чтобы не трогать
  этот binary, а release build заново прогоняет проверку на финальном,
  подписанном bundle — поэтому release, в котором Codex runtime не смог бы
  стартовать, просто не соберётся.

## ChatGPT (Codex)

Card **ChatGPT (Codex)** запускает тот же bundled Codex harness на вашей
собственной подписке ChatGPT вместо gateway. Она создаёт `codex-runtime`
connection (slug `chatgpt-codex`) с `authType: "oauth"` и
`codexModelProvider: "openai"`.

- **Build flag**: собственного нет. Card предлагается только в сборке с
  `NESSY_FEATURE_PROVIDER_CHATGPT=1` (по умолчанию выключен; это флаг card
  ChatGPT Plus), в которую также входит Codex runtime. С выключенным флагом не
  предлагается ни одна ChatGPT card; уже существующая connection продолжает
  работать.
- **Sign-in**: вы входите своим аккаунтом ChatGPT в браузере, через тот же
  вход, что и у card ChatGPT Plus. Каждая card хранит свой собственный вход:
  OpenAI заменяет refresh token при каждом использовании, и две cards с одним
  общим token выбивали бы друг друга. При старте session приложение обновляет
  token, если он истёк, и передаёт его Codex; когда Codex позже просит свежий,
  приложение отвечает из входа этой card. Если вход выполнить не удаётся,
  session останавливается с карточкой входа, описанной в разделе
  [Когда credential истекает](#когда-credential-истекает). Codex помечает способ
  входа, которым пользуется эта card, как experimental, поэтому будущий release
  Codex может его изменить.
- **Куда идут turns**: в собственный provider Codex `openai`, который
  отправляет session, вошедшую в ChatGPT, на `chatgpt.com` — то есть на вашу
  подписку. Локальный adapter не запускается, Nessy Gateway не участвует.
- **Models**: card начинает с собственного встроенного списка моделей Codex
  (default `gpt-6.1-sol`). После входа каждая session обновляет список из
  собственного каталога Codex, так что он следует тому, что даёт ваш аккаунт.
  Default model, которой Codex больше не перечисляет, переходит на default
  самого Codex, а список, выбранный вами вручную
  (`modelSelectionMode: "userDefined3Tier"`), не трогается. Модель, которую
  Codex перечисляет как text-only, не принимает image attachments: composer
  перестаёт их для неё предлагать, а уже прикреплённое изображение не уходит в
  сообщение, и об этом появляется notice.
- **Web search**: здесь включён собственный web search Codex, тогда как на всех
  остальных Codex cards он выключен. Собственный tool приложения `web_search`
  рядом с ним не предлагается, так что модель видит один search tool, а
  [`NESSY_WEB_SEARCH_ALLOWED_DOMAINS`](./environment-variables#nessy-web-search-allowed-domains),
  если задан, передаётся Codex как список
  доменов, которыми может пользоваться его поиск. У поиска Codex нет лимита на
  session, поэтому
  [`NESSY_MAX_WEB_SEARCHES_PER_SESSION`](./environment-variables#nessy-max-web-searches-per-session)
  его не останавливает; когда session превышает этот cap, чат один раз об этом
  сообщает.
- **`/quota`** показывает окна использования подписки так, как их сообщает
  Codex, — см. [Interactions](../../core-concepts/interactions). Когда Codex уже
  сообщил эти окна session, turn, остановленный лимитом подписки, называет,
  когда лимит сбросится, и просит отправить сообщение после этого времени. Сам
  Codex остановленный turn не продолжает, поэтому
  [`NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT`](./environment-variables#nessy-auto-continue-at-usage-limit)
  меняет здесь только это сообщение.
- **Недоступно**: заголовки sessions и другие one-shot completions. У
  приложения нет пути к provider Codex вне turn Codex, и оно не отправляет их
  вместо этого в Nessy Gateway, поэтому session сохраняет заголовок по
  умолчанию.
- **Куда уходят ваши tools**: строка под списком моделей, которая называет, куда
  отправляются schemas ваших MCP tools, для этой card называет `chatgpt.com` —
  как и для ChatGPT Plus на Pi; см.
  [External models](../../sources/mcp-servers/external-models).

## Custom runtime endpoints

Card **Custom runtime endpoint** (onboarding и Settings → AI →
**+ Add Connection**) с 1.26.0 — **единственный** вход для персонального key:
отдельная карточка «API key» слита в неё. Одна форма, три runtime:

- **Runtime** выбирает harness, под которым работает ваш key: **Pi agent**,
  **Claude Code** или **Codex**. На арме Pi вместо custom endpoint можно выбрать
  официальный preset провайдера (OpenAI, Anthropic) — тогда используются его
  собственный endpoint и каталог, а `baseUrl` не сохраняется.
- **Endpoint** больше не вводится вручную. Новая connection создаётся против
  внутреннего LLM proxy, поэтому поле скрыто. Исключение — Edit-путь для
  connection, указывающей в другое место: тогда поле показывается
  **заблокированным** со сохранённым URL, и он отправляется дословно —
  существующий endpoint нельзя молча переместить пересохранением. Точный URL
  Nessy Gateway отклоняется на любом арме: его уже покрывают one-click cards, а
  connection с персональным key на этом URL не использовала бы ваш key и сразу
  потеряла бы возможность редактирования.
- **API key** можно оставить пустым для loopback endpoint (локальные серверы
  класса Ollama); connection тогда сохраняется с `authType: "none"`, и её
  запросы не несут auth header. На Edit-пути пустой key означает «оставить
  сохранённый».
- **Models** приходят от endpoint. **Fetch models** читает опубликованный
  каталог и проверяет, до чего реально достаёт ваш key — см.
  [Custom Endpoints → отметки доступности](/reference/config/custom-endpoint).
  Выбранные модели показываются чипсами; первый чипс — default, клик по чипсу
  переносит его туда. Поле со списком через запятую скрыто при создании (вход
  только через picker) и сохраняется на всех Edit-путях — для сохранённой
  connection, каталог которой получить нельзя. Vendor-специфика, не
  переживающая OpenAI-compatible провод (thinking signatures, prompt caching),
  на этих connections недоступна.
- **Utility model** выбирает, какая из выбранных моделей используется для
  заголовков чатов и коротких внутренних completions; хранится как `miniModel`.
  *Automatic* оставляет поле пустым, и выбор делает существующая эвристика. На
  connection Claude Code это ещё и модель, на которой идёт `call_llm` агента,
  когда он не называет модель или называет модель Claude, которой нет в списке
  connection.
- **Editing** открывает ту же форму с заблокированным runtime: существующая
  connection никогда не меняет harness, а сохранённый key переживает пустой
  submit.

Созданная здесь connection автоматически участвует в 24-часовом обновлении
метаданных моделей (`modelsSyncedAt`); форма также сохраняет показанный размер
контекста, поэтому connection полна ещё до первого обновления.

## Примеры

### Nessy Gateway (bearer token)

```json
{
  "slug": "nessy-gateway",
  "name": "Nessy Gateway",
  "providerType": "pi_compat",
  "piAuthProvider": "openai",
  "authType": "bearer_token",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Claude Code runtime (gateway one-click)

```json
{
  "slug": "claude-gateway",
  "name": "Claude Code (Nessy Gateway)",
  "providerType": "claude-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Codex runtime (gateway one-click)

```json
{
  "slug": "codex-gateway",
  "name": "Codex (Nessy Gateway)",
  "providerType": "codex-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

Начиная с 1.25.1 агенты, которые вы определили (или установили плагином),
регистрируются в каждой Codex-сессии как Codex agent roles — модель может
запускать их по имени; это те же определения, которые диспатчат Pi и Claude
runtime. Агент, объявляющий собственный список инструментов или permission
mode, ролью выражен быть не может (у Codex нет per-role tool policy) и
пропускается с причиной в логе сессии.

### Custom runtime endpoint (BYO, любой runtime)

```json
{
  "slug": "codex-custom",
  "name": "Codex (Custom Endpoint)",
  "providerType": "codex-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://llm-proxy.internal.example.com/v1",
  "defaultModel": "deepseek-v3",
  "models": ["deepseek-v3", "deepseek-r1"],
  "createdAt": 1737451800000
}
```

Keyless loopback endpoint (локальный класс Ollama) — та же форма с
`"authType": "none"` и без сохранённого credential; `claude-custom` /
`providerType: "claude-runtime"` — близнец для Claude Code.

### Anthropic (API key)

```json
{
  "slug": "anthropic-api",
  "name": "Anthropic (API Key)",
  "providerType": "anthropic",
  "authType": "api_key",
  "defaultModel": "claude-sonnet-4-6",
  "createdAt": 1737451800000
}
```

### Claude subscription (OAuth)

```json
{
  "slug": "claude-max",
  "name": "Claude Pro/Max",
  "providerType": "anthropic",
  "authType": "oauth",
  "createdAt": 1737451800000
}
```

### ChatGPT Plus on Pi (OAuth)

Card **ChatGPT Plus (Pi)**: агент Pi на вашей подписке ChatGPT. До 1.41.0 card
называлась «Codex · ChatGPT Plus»; connection, которую она сохраняет, по-прежнему
называется `ChatGPT Plus`.

```json
{
  "slug": "chatgpt-plus",
  "name": "ChatGPT Plus",
  "providerType": "pi",
  "piAuthProvider": "openai-codex",
  "authType": "oauth",
  "modelSelectionMode": "automaticallySyncedFromProvider",
  "createdAt": 1737451800000
}
```

### ChatGPT on the Codex runtime (OAuth)

Card **ChatGPT (Codex)** — см. [ChatGPT (Codex)](#chatgpt-codex). Connection
также несёт список моделей Codex (`models`), здесь он опущен.

```json
{
  "slug": "chatgpt-codex",
  "name": "ChatGPT (Codex)",
  "providerType": "codex-runtime",
  "authType": "oauth",
  "codexModelProvider": "openai",
  "defaultModel": "gpt-6.1-sol",
  "createdAt": 1737451800000
}
```

### Local Ollama (custom endpoint)

```json
{
  "slug": "ollama",
  "name": "Ollama",
  "providerType": "pi_compat",
  "authType": "none",
  "baseUrl": "http://localhost:11434/v1",
  "customEndpoint": { "api": "openai-completions" },
  "models": [
    { "id": "gemma4", "contextWindow": 262144, "supportsImages": true },
    { "id": "qwen3-coder", "contextWindow": 131072 }
  ],
  "defaultModel": "qwen3-coder",
  "createdAt": 1737451800000
}
```

## Возможности custom endpoint

Custom endpoints нельзя probe, поэтому defaults — **131,072-token context
window**, **8,192-token max output** и **text-only** input. Повышайте их явно.

Используйте per-model objects, когда один endpoint держит набор разных models:

```json
{
  "customEndpoint": { "api": "openai-completions" },
  "models": [
    { "id": "gemma4", "contextWindow": 262144, "supportsImages": true },
    { "id": "qwen3-coder", "contextWindow": 131072 }
  ]
}
```

Или включите image input для всего endpoint сразу:

```json
{
  "customEndpoint": {
    "api": "openai-completions",
    "supportsImages": true
  }
}
```

::: info
Nessy Desktop никогда не угадывает image support. Model-level setting важнее
endpoint-wide setting, поэтому `supportsImages: false` на одной model выключает
vision для нее даже при endpoint default `true`. Models, заданные bare strings,
сохраняют text-only, 131,072-token defaults.
:::

UI toggle и pre-flight banner описаны в
[Custom Endpoints → Image input](custom-endpoint#image-input-для-custom-endpoints).

## Движок web search на Pi

На Pi connection `web_search` выбирает движок по connection:

- **Собственный поиск provider** — OpenAI (API key `openai`), ChatGPT (вход по
  подписке ChatGPT, `openai-codex`), OpenRouter или Google (Gemini с Google
  Search grounding) — только когда connection обращается к собственному
  public API этого provider: у неё нет своего base URL или host её base URL в
  точности совпадает с API host этого provider (`api.openai.com`,
  `chatgpt.com`, `openrouter.ai`, `generativelanguage.googleapis.com`). Тогда
  поиск уходит на тот же host, что и model calls connection, с тем же
  credential.
- **DuckDuckGo** во всех остальных случаях: card Nessy Gateway, любой custom
  endpoint (включая llm-proxy и другие OpenAI-compatible servers), base URL на
  любом другом host и base URL, который не удаётся разобрать. DuckDuckGo не
  нужен key, так что credential connection никогда не уходит на search host,
  которым её model calls и так не пользуются.

Если собственный поиск provider падает, тот же запрос выполняется в DuckDuckGo,
и результат об этом сообщает. Каждый результат называет свой движок
(`via DuckDuckGo`). Собственный `web_search` приложения, который получают
sessions Claude Code и Codex, всегда ищет в DuckDuckGo.
[`NESSY_WEB_SEARCH_ALLOWED_DOMAINS`](./environment-variables#nessy-web-search-allowed-domains)
и
[`NESSY_MAX_WEB_SEARCHES_PER_SESSION`](./environment-variables#nessy-max-web-searches-per-session)
действуют, какой бы движок ни ответил.

## Mid-stream behaviour

Если новый message отправляется mid-turn — агент все еще streaming previous
reply — `midStreamBehavior` у connection выбирает между добавлением в текущий
turn и постановкой в очередь для следующего.

| Value     | Behaviour                                                                                |
| --------- | ---------------------------------------------------------------------------------------- |
| `"steer"` | Deliver the message into the current turn (Pi's and Codex's native steer, or Claude hook injection). |
| `"queue"` | Hold the message, let the current turn finish, then replay it as a new turn.             |

Какое бы значение ни было задано, message с вложениями всегда ставится в
очередь: steer переносит только текст, поэтому файлы уходят вместе с message в
следующем turn.

```json
{
  "slug": "anthropic-api",
  "providerType": "anthropic",
  "authType": "api_key",
  "midStreamBehavior": "queue",
  "createdAt": 1737451800000
}
```

### Defaults by backend

Когда `midStreamBehavior` отсутствует, default зависит от provider type:

- **`pi` / `pi_compat`** → `"steer"`. Здесь steering native и ничего не теряет:
  когда running tool завершается, ваш message попадает внутрь с целым
  conversation context.
- **`codex-runtime`** → `"steer"`. Тоже native и строже, чем у Pi, причём
  полезным образом: собственный steer-вызов рантайма несёт id того turn, которому
  он предназначен, поэтому правка, нацеленная на turn, который уже ушёл вперёд,
  отклоняется рантаймом, а не применяется не туда. Два вида turn отказываются от
  steering вовсе — review и compaction, — и message, отклонённый по любой из этих
  причин, ставится в очередь, а не теряется.
- **`anthropic` / `claude-runtime`** → `"steer"` (с 2026-08-17). Claude backend
  эмулирует steering: message передаётся модели при её следующем tool call. Если
  tool call не приходит, message ставится в очередь и проигрывается следующим
  turn — ничего не теряется, цена — tokens уже прошедшего turn. Connections,
  созданные до этого изменения, по-прежнему хранят `"queue"` (см. абзац ниже).
- **`nestor-cloud-agent`** → `"queue"`. Удалённый агент не предоставляет никакой
  доставки внутрь turn.

**Default действует только на connection, у которой нет сохранённого значения, а
у connection оно обычно есть.** Значение записывается при создании connection,
поэтому default, изменившийся в более позднем релизе, не доходит до уже
имеющихся у вас connections — и это сделано намеренно: сохранённое значение не
несёт никакой пометки о том, пришло оно из default или от вас, и перезапись
молча отменила бы реальный выбор. Чтобы взять новый default на существующей
connection, задайте его сами в UI ниже.

### Изменение из UI

Откройте **Settings → AI**, найдите connection в **Connections**, откройте ее
menu и выберите mid-stream option. Это per-connection setting, который действует
со следующей mid-stream отправки. User-facing walkthrough см. в
[Interactions → sending while the agent is responding](../../core-concepts/interactions#отправка-во-время-ответа-агента).

## Управление connections

Connections управляются в **Settings → AI**: добавляйте, редактируйте и удаляйте
connections, а также задавайте global default.

::: info
У корпоративной connection Nessy Gateway нет пункта **Edit** — её форма
редактирования показала бы сохранённый gateway JWT, а настраивать руками там
нечего (auth в один клик). Остаются доступны **Reconnect**, который заново
запускает тот же вход в один клик, не открывая никакой формы, а также Rename,
Validate, Mid-stream sends и Delete. Повторный запуск gateway card обновляет
connection на месте.
:::

### Проверка редактируемого подключения

Когда вы редактируете подключение с сохранённым API-ключом, поле ключа показывает
его в замаскированном виде — первые семь символов, ряд точек и последние четыре
(короткий ключ — одни точки). Сам ключ в окно никогда не попадает.

Проверить подключение можно, не вводя ключ заново: проверка с замаскированным
значением использует ключ, сохранённый для этого подключения, — приложение
находит его само. Введённый вами ключ на время проверки заменяет
сохранённый. Если приложение не может взять сохранённый ключ, проверка прямо
говорит об этом, а не проходит и не пропускается:

- "No API key is stored for this connection. Re-enter the key to test it." — у
  подключения нет сохранённого ключа.
- "Re-enter the API key to test this connection." — замаскированное значение
  пришло без подключения, к которому оно относится.

Это касается каждой карточки подключения с полем ключа — Pi, Claude Code и Codex
одинаково, — потому что проверка выполняется в приложении, а не в рантайме.

## Когда credential истекает

Когда credential соединения перестаёт работать посреди чата — истёк OAuth-token
подписки, отозван сохранённый ключ, рантайм сообщил о недействительном или
приостановленном credential, — чат показывает одну карточку с причиной и одной
кнопкой **Sign in**, на любом рантайме. Кнопка открывает **Settings → AI** с уже
выбранным соединением, которое отказало, — чтобы в приложении с несколькими
соединениями не пришлось искать нужное самому.

Это заменило два разных поведения. На Claude Code тот же отказ приходил типовой
ошибкой, единственным действием которой была ссылка на страницу настроек; на Pi —
строкой в транскрипте вообще без действия. У корпоративной карточки Nessy Gateway
своя карточка входа той же формы — см.
[Устранение проблем со входом в шлюз](credentials#устранение-проблем-со-входом-в-шлюз).
