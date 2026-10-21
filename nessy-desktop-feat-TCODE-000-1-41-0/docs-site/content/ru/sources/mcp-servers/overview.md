# MCP Servers

Model Context Protocol (MCP) — open standard для предоставления tools AI agents. Nessy Desktop говорит на MCP нативно: укажите source на MCP server — remote или local — и каждый tool, опубликованный этим server, станет доступен агенту в sessions. Issue trackers, search engines, databases и internal services всё чаще поставляют MCP endpoint, а всё, что запускается как local process, можно обернуть в такой server.

## Что даёт connection

Добавление MCP source обучает агента новому набору actions. Linear connection позволяет искать и обновлять issues прямо в conversation; database server — выполнять queries; filesystem server — просматривать directory tree. Glue code не нужен: server описывает свои tools, а агент выбирает нужный из context.

Несколько свойств стоит знать заранее:

- **Namespaced tools.** Каждый tool регистрируется как `mcp__<slug>__<toolName>`, где slug derived from source name. Tools разных servers не конфликтуют.
- **Имена приводятся к тому, что вмещает имя tool.** В slug остаются только буквы, цифры, `-` и `_`, поэтому имя сервера с чем-то ещё — пробелом, точкой — преобразуется, а не ломает собственные tools: `my server.v2` становится `my_server_v2`. Имя, в котором нет ни одного пригодного символа (целиком кириллическое или японское), получает стабильное сгенерированное `server-<короткий код>` вместо пустого. [Permission rule](../../core-concepts/permissions) пишется именно против преобразованного slug, а не против исходной строки, которую вы ввели, — панель **MCP servers** продолжает показывать имя так, как вы его написали. Для обычного имени slug выводится из правила выше (`my server.v2` → `my_server_v2`); сгенерированный `server-<короткий код>` виден в именах собственных tools сервера — `mcp__server-<короткий код>__<toolName>` — при первом запросе разрешения любым его tool. В редком случае, когда имя всё же не годится для имён tools, сервер показан с причиной **«Имя этого сервера нельзя использовать в именах инструментов; его инструменты недоступны»**, а не выглядит здоровым с пустым списком tools.
- **Загружаются по требованию.** Описания инструментов сервера не перечисляются целиком в начале каждого сообщения. Агент получает индекс для поиска и подтягивает полное описание инструмента в тот момент, когда решает им воспользоваться, — большой каталог перестаёт съедать разговор ещё до его начала. Ничего не становится недоступным: все подключённые инструменты остаются достижимыми, и нужный приходит раньше, чем будет вызван. В Pi инструмент, который агент загрузил, можно вызвать уже со следующего шага того же запроса (но не в той же пачке вызовов, что его загрузила), и он остаётся загруженным при обновлении каталога, если только не изменился сам инструмент (его описание, входные параметры или источник) — тогда агент загружает его заново. Закрепите инструменты сервера через `alwaysLoad`, если они должны присутствовать сразу, — это обещание безусловное. Закрепление всех инструментов одного сервера не выключает механизм для остальных, а полное выключение — отдельная настройка, а не побочный эффект закрепления.
- **Shared pool.** MCP tools живут в том же source pool, что [API sources](../apis/overview) и [local folders](../local-filesystems). Каждый workspace держит ОДНО общее соединение на сервер: сколько бы чатов его ни использовали, сервер запускается один раз и живёт keep-alive, а закрытие чата никогда не перезапускает сервер, который использует другой чат. Session включает specific source slugs и видит только свой набор — серверы другого чата не появляются в её tool list, а tool responses всегда сохраняются в её собственную session.
- **Dynamic catalogs.** Notifications `tools/list_changed`, `resources/list_changed` и `prompts/list_changed` serially refresh одно connection и atomically swap validated routes. Failed refresh сохраняет last good catalog и показывает degraded health; withdrawn tool недоступен на следующем Pi turn.
- **Session-bound channels.** Bounded events `notifications/claude/channel` получает только session с matching live connection lease, обёрнутыми в тег `<channel source="...">`, атрибуты которого несут routing keys события. Notification может разбудить idle session, держащую lease, а несколько событий за один turn доставляются одной группой на следующем turn — но session никогда не создаётся, а событие, пришедшее до вашего первого сообщения, придерживается как контекст к нему и не начинает собственный turn. Channel push выключен, пока вы не включите его в Settings -> Permissions.
- **Scoped secrets.** Credentials созданных пользователем sources хранятся per workspace и per source, encrypted on disk. Removing source removes its secrets. (Plugin-owned серверы отличаются: их credential глобален для сервера — см. ниже.)

## Plugin-provided MCP servers

[Plugins](../../plugins/overview) могут contribute MCP server descriptors. Серверы плагина — remote и stdio одинаково — принадлежат плагину: они работают из installed plugin cache на собственном runtime-пути плагина, никогда не становятся source folders и не добавляют slugs в список sources. В Sources остаются **только созданные пользователем подключения**.

Из этого владения следуют несколько вещей:

- **Один credential на сервер, везде.** Plugin server с OAuth или bearer token держит один глобальный credential, ключ — plugin и server name, в encrypted vault. Войдите один раз — и каждый workspace использует этот grant: серверы плагина не дублируются по workspaces и никогда не просят аутентифицировать один сервер дважды. (Sources, созданные пользователем, сохраняют per-workspace scoping.)
- **Одна панель для всех серверов.** Панель **MCP servers** перечисляет все MCP-серверы вместе — plugin-owned и созданные пользователем — с origin, transport и auth state каждой строки. Строки плагина несут per-server переключатель: один сервер из десяти можно выключить, не трогая остальные; страница плагина показывает те же строки, отфильтрованные до этого плагина.
- **Стабильное, plugin-qualified wire name.** Tools plugin-сервера namespaced самим плагином, а не только именем сервера: wire name всегда `plugin_<pluginId>_<serverName>`, а не короткая форма `<serverName>`, которую получает built-in или ваш собственный source — даже если ни один другой сервер не носит такое же имя. Установка нового плагина поэтому никогда не может забрать, сдвинуть или столкнуться с именем, которое уже принадлежит built-in или вашему собственному серверу.
- **Одна копия на declared endpoint.** Когда два плагина объявляют сервер по одному адресу (или с одной и той же local command) с одинаковыми declared credentials, подключается только один; второй показан с причиной **«Дублирует endpoint другого сервера; работает одна копия»** вместо запуска лишнего процесса. Declared credentials — часть этой identity: два плагина с разными credentials к одному адресу считаются разными серверами, и работают оба.
- **Отступивший сервер называет, что затихло вместе с ним.** Когда сервер плагина не запускается — как дубль built-in или endpoint другого плагина — собственные hooks и skills этого плагина, ссылавшиеся на него, тоже перестают работать: они указывают на то, что уже не запустится. Страница сервера — та, которую открывает строка, — называет их: **«Части плагина, использовавшие этот сервер, не работают:»** и список имён, так что причина покрывает весь эффект, а не только сервер. (Agents, которые несёт плагин, там пока не перечисляются.)

Включённые серверы подключаются при старте сессии (по умолчанию). `sources.connectOnStartup: false` в `config.json` — или managed-ключ `connectSourcesOnStartup` — возвращает подключение по первому обращению. Сервер, ещё ждущий входа, или сервер, чьё стартовое подключение не удалось, перечислен в ненавязчивом notice при старте сессии; вход из него никогда не прерывает разговор.

Stdio-серверы плагинов следуют более строгим правилам, чем пользовательские stdio sources: команда резолвится внутри verified plugin bundle (абсолютный путь, без PATH lookup), а процесс не наследует ваш environment. Enabling плагина управляет тем, видимы ли его серверы сессии.

Disable или uninstall plugin withdraws его catalog из следующего turn,
останавливает plugin-owned processes и drains active leases до release
immutable plugin bytes. Uninstall также вычищает credential-слоты плагина.

Архивы Claude Desktop `.mcpb` и `.dxt` устанавливаются как plugins, а не как
Sources. Их declared fields настраиваются на странице plugin; sensitive values
остаются в encrypted credential store, после чего packaged server подключается
к тому же workspace MCP pool.

## Встроенные MCP servers

Nessy поставляется с каталогом tool servers, которые предоставляет `dp` CLI —
Jira, GitLab, merge requests, Sage, Wiki, code search, Allure, Kubernetes и
остальные из `dp ai mcp`. Они видны в **Sources → MCPs** рядом с вашими
подключениями и плагинными, как обычные MCP sources с бейджем происхождения
**Built-in**.

Что о них стоит знать:

- **Отдельного credential нет, но `dp` должен быть авторизован.** Каждый
  запускается как `dp ai mcp <подкоманда>` и авторизуется из собственной сессии
  `dp` — Nessy не передаёт токен и никогда не читает файл учётных данных dp,
  настраивать нечего. Если `dp` разлогинен, включённый встроенный server
  временно скрывается и появляется в notice при старте сессии с кнопкой
  **Sign in** в один клик; вход (из notice или через `dp auth login` вручную)
  переподключает его автоматически, без перезапуска.
- **Бинарник ваш, а не наш.** Nessy не вшивает `dp`, а находит тот, что уже есть
  в `PATH`. На машине без него набор помечается недоступным с диагностикой,
  называющей `dp`, вместо переключателей, которые не сработают.
- **Всё выключено, пока вы не включите.** Ни один встроенный server не
  стартует без спроса ни на одной машине, и релиз, добавивший новый, тоже
  оставит его выключенным. Выбор по каждому хранится в `config.json` под ключом
  `builtinDpMcpServers`.
- **Ваш собственный server всегда побеждает.** Если вы уже определили server с
  тем же именем — или запускающий ту же подкоманду `dp ai mcp` — встроенный
  отступает, а не затеняет ваш.
- **Копия плагина, дублирующая включённый built-in, отступает.** Если
  установленный плагин несёт собственную копию сервера, запускающего ту же
  подкоманду `dp ai mcp`, что и включённый built-in, копия плагина не
  запускается — вместо этого она показана с причиной **«Дублирует встроенный
  сервер; используется встроенный»** и списком собственных hooks и skills
  плагина, которые ссылались на неё и потому не работают. Выключение built-in
  позволяет копии плагина запуститься.
- **Работает тихо и неинтерактивно.** Собственный баннер dp об обновлениях и
  любой интерактивный запрос входа для этих subprocess подавлены, так что
  разлогиненный `dp` сразу уходит в notice для входа, а не печатает
  предупреждения в stdout или пытается сам открыть браузер.

## Anatomy source

Каждый source — folder внутри workspace:

```
~/.nessy-agent/workspaces/<workspace-id>/sources/<slug>/
├── config.json   # connection settings
└── guide.md      # usage notes the agent reads before using the source
```

Типичный `config.json` для remote MCP server:

```json
{
  "id": "linear_a1b2c3d4",
  "name": "Linear",
  "slug": "linear",
  "enabled": true,
  "provider": "linear",
  "type": "mcp",
  "tagline": "Issue tracking and project management",
  "icon": "https://linear.app/favicon.ico",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.linear.app/mcp",
    "authType": "oauth"
  }
}
```

Когда app создаёт source за вас, `id`, `slug` и `enabled` заполняются автоматически — slug берётся из name, а duplicate names получают numeric suffix.

### Configuration Fields

| Field | Required | Purpose |
| --- | --- | --- |
| `type` | Yes | `"mcp"` выбирает MCP connection type |
| `name` | Yes | Display label; также основа generated slug и tool prefix |
| `provider` | Yes | Freeform label для grouping и provider-specific behavior |
| `tagline` | No | One-line summary для UI и агента; fallback к первому paragraph `guide.md` |
| `icon` | No | Emoji или image URL; если unset, `icon.svg` или `icon.png` из source folder подхватывается automatically |
| `mcp.transport` | No | `"http"` (default), `"sse"` или `"stdio"` |
| `mcp.url` | HTTP/SSE | Full endpoint URL remote server |
| `mcp.authType` | HTTP/SSE | `"oauth"`, `"bearer"` или `"none"` — см. [Authentication](authentication) |
| `mcp.command` | stdio | Executable, запускающий local server |
| `mcp.args` | No | Argument list для stdio command |
| `mcp.env` | No | Extra environment variables для stdio process |
| `mcp.headers` | No | Static, non-secret headers для каждого HTTP/SSE request |
| `mcp.headerNames` | No | Names of secret headers, whose values come from credential vault |

## Transport Types

### HTTP (Remote Servers)

Default transport. App connects over Streamable HTTP и проверяет server, listing its tools:

```json
{
  "type": "mcp",
  "name": "Exa Search",
  "tagline": "Web search and content extraction",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.exa.ai/mcp",
    "authType": "bearer"
  }
}
```

Trailing slashes на URL удаляются, но path используется exactly as written — ничего не appended, поэтому указывайте full endpoint path server (часто заканчивается на `/mcp`).

Значение transport `"sse"` поддерживается для старых Server-Sent Events servers и передаётся в agent runtime as-is. Для modern integrations предпочитайте `"http"`; built-in connection test всегда говорит Streamable HTTP.

### Stdio (Local Servers)

Для servers, запускаемых subprocess на вашей машине:

```json
{
  "type": "mcp",
  "name": "SQLite",
  "tagline": "Query a local SQLite database",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/data.db"]
  }
}
```

Common launch patterns:

| Pattern | Config |
| --- | --- |
| npm package | `"command": "npx", "args": ["-y", "some-mcp-package"]` |
| Node script | `"command": "node", "args": ["/Users/me/mcp/server.js"]` |
| Python script | `"command": "python", "args": ["/Users/me/mcp/server.py"]` |
| uv-managed tool | `"command": "uvx", "args": ["some-mcp-tool"]` |
| Compiled binary | `"command": "/usr/local/bin/my-mcp-server"` |

Stdio servers не требуют network authentication — см. [stdio credentials](authentication#local-servers-stdio), как безопасно передавать secrets.

## Local Process Safety

Так как stdio servers — arbitrary programs, Nessy Desktop ограничивает наследование:

- **Filtered environment.** Subprocess получает normal environment минус blocklist high-value secrets — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, AWS access keys and session tokens, `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY` и `NPM_TOKEN`. Всё, что явно задано в `mcp.env`, передаётся поверх filtered base.
- **Workspace kill switch.** У каждой workspace есть setting `localMcpServers.enabled`. Когда он выключен, stdio sources показывают status `local_disabled`, а работают только network-based servers. Environment variable `NESSY_LOCAL_MCP_ENABLED` overrides default — см. [environment variables](../../reference/config/environment-variables).

Подключайте только stdio servers, whose code you trust: они выполняются с permissions вашего user account.

## Ресурсы и промпты

Кроме инструментов, MCP-сервер может публиковать ещё два вида содержимого, и агент умеет пользоваться обоими.

**Ресурсы** — документы или записи, которые сервер адресует по URI (файл, задача, страница), а также **шаблоны**: образцы URI с `{заполнителями}`, которые агент заполняет, чтобы назвать ресурс.

- В Claude Code и Codex агент читает их собственными инструментами ресурсов рантайма. В Pi Nessy Desktop даёт ему `list_mcp_resources` и `read_mcp_resource`.
- Список проходит все страницы сервера до конца и включает его шаблоны. Сервер, который не предлагает шаблонов, просто не показывает ни одного.
- Ресурс возвращается текстом. Двоичный ресурс сохраняется в папку загрузок сессии и называется в ответе, а очень большой обрабатывается как любой большой результат инструмента и не заваливает переписку.

**Промпты** — переиспользуемые инструкции или сценарии с аргументами, которые публикует сервер. Ни один рантайм не даёт агенту получать их самостоятельно, поэтому Nessy Desktop добавляет каждой сессии два инструмента только для чтения — одинаково в Pi, Claude Code и Codex:

- `source_list_prompts` перечисляет промпты источника и их аргументы.
- `source_get_prompt` возвращает один промпт с подставленными аргументами в виде текста.

Агент использует их, когда вы просите выполнить один из сценариев источника или когда на него указывает руководство источника. Промпт — это только текст от сервера: он не даёт разрешений и не отменяет ваших указаний. Для источника без промптов, API-источника или неподключённого сервера ответ прямо говорит об этом. Оба инструмента не требуют одобрения ни в одном режиме, потому что только читают.

## Что подключено на самом деле

Панель MCP раньше показывала то, что *написано* в конфигурации, а это другой
вопрос, чем то, что *есть* у сессии. Теперь она несёт живой статус пула — ту же
инвентаризацию, которую печатает `/mcp`, — так что сервер, который не смог
подключиться, помечен на строке как упавший, с причиной, а не выглядит так же,
как здоровый. Подключённый сервер, не отдавший ни одного инструмента, тоже
отмечается отдельно: это читается как «сломан», хотя обычно это не так. В sessions
Pi, Codex и Claude Code подключённый сервер, которому пришлось пропустить часть своих
инструментов, помечен «Часть инструментов пропущена»; наведите курсор на метку,
чтобы прочитать, какие инструменты пропущены и почему.

Отдельный сервер можно переподключить с его строки, ничего больше не
перезапуская. Такого глагола раньше не было: единственным способом восстановления
была полная перезагрузка конфигурации.

## Finding MCP Servers

- [Official MCP server registry](https://github.com/modelcontextprotocol/servers) lists reference and community servers.
- Многие SaaS products документируют hosted MCP endpoint рядом со своим REST API — смотрите developer docs.
- Internal tools могут expose собственный server; protocol SDKs делают minimal stdio server short exercise.

::: info Plain REST API instead?
Если у service хороший HTTP API, но нет MCP server, MCP может и не понадобиться — [API sources](../apis/overview) напрямую превращают REST endpoints в tools, включая Google APIs с built-in OAuth support.
:::

## Security Notes

- Созданные пользователем sources и их credentials scoped к одной workspace. Другая workspace, подключающая тот же сервер, аутентифицируется отдельно. Plugin-owned server — намеренное исключение: его credential глобальный, один вход действует во всех workspaces.
- Secrets не лежат в `config.json`. Они хранятся в encrypted vault `~/.nessy-agent/credentials.enc` — см. [credentials](../../reference/config/credentials).
- То, что агент может делать с connected tools, задаётся [permission mode](../../core-concepts/permissions) session.

## Дальше

- [Connecting servers](connecting-servers) — пошаговая настройка remote и local servers плюс troubleshooting.
- [Authentication](authentication) — OAuth, bearer tokens, custom headers и credential storage.
- [MCP-серверы организации](managed-servers) — удалённые серверы, которые администратор через managed policy выдаёт каждой сессии.

## Graphify · база знаний Odysseus

Из корня Odysseus выполните `npm run knowledge:setup`: источник Graphify подключает общий граф проектов и Obsidian. Хранилище выбирается автоматически, при отсутствии создаётся новое. При работе CLI/Desktop через launcher графы обновляются в отдельном процессе. Связи имеют источники; общий пакет означает общий стек. Для подробных символов передавайте graphify_project_path узла проекта как project_path инструментам MCP.

В Desktop карта доступна в «База знаний»: поиск, раскрытие узлов и источники связей. «Чат с базой знаний» открывает сохранённую беседу встроенного агента; ручные записи и связи сохраняются отдельно от автоматического индекса.

В карте есть режим «Каталоги» с навигацией по проектам и папкам; «Связи» открывает окружение узла. «Читать источник» открывает Markdown/код внутри Desktop. Сохранённые изменения появляются без перезагрузки.

Каталоги знаний отделяют контекст проектов: «Мои проекты», «Odysseus» и пользовательские каталоги. Каждый каталог имеет отдельную беседу агента и MCP-граф. Служебный Odysseus не входит в рабочий каталог по умолчанию.

## Obsidian: синхронизация каталогов

Кнопка «Синхронизировать всё с Obsidian» на карте знаний обменивается Markdown-заметками и ручными связями всех каталогов. Одновременные правки сохраняются как конфликт. Автоматические связи исправляются в исходниках. Обмен выполняется по кнопке в отдельном процессе; неизменённые файлы не переписываются.
