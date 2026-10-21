# Environment Variables

Большинству людей environment variables не нужны: повседневная конфигурация
живет в Settings и [config file](config-file). Environment variables в основном
важны для [CLI](../cli) automation, local development, proxy setup и
release/installer tooling.

::: info
Многие internal variables называются `NESSY_*`. Они унаследованы от upstream
codebase и поддерживаются без изменений для совместимости server, Electron
shell и CLI runtime contracts.
:::

::: warning Запуск из Dock, Finder или Spotlight (macOS)
Приложение читает окружение вашей login shell при запуске, но переменные
провайдеров Bedrock и AWS, например `ANTHROPIC_BEDROCK_BASE_URL` и `AWS_REGION`,
не доходят до его агентов, если они экспортированы только в login shell:
при запуске приложение сбрасывает их к значениям, с которыми оно было запущено,
а запуск из Dock их не передаёт. Запустите приложение из терминала, где они
экспортированы, или задайте их для всех приложений через `launchctl setenv` и
перезапустите приложение.
:::

## Выбор модели для CLI

Команда [CLI](../cli) `run` читает эти переменные, если соответствующий flag не
передан:

| Variable       | Flag          | Purpose                                             |
| -------------- | ------------- | --------------------------------------------------- |
| `LLM_PROVIDER` | `--provider`  | Provider name (defaults to `anthropic`)             |
| `LLM_MODEL`    | `--model`     | Model id                                            |
| `LLM_API_KEY`  | `--api-key`   | API key (or a provider-specific key such as `OPENAI_API_KEY`) |
| `LLM_BASE_URL` | `--base-url`  | Custom endpoint base URL                            |

## Configuration directory

### NESSY_CONFIG_DIR

Задаёт `CONFIG_DIR`. Если переменная не указана, `CONFIG_DIR` равен
`~/.nessy-agent`. В нём находятся global config и credentials, ресурсы
Workspace, глобальные разделы сессий, история внешних Project, состояние
плагинов и логи:

```
CONFIG_DIR/
  config.json
  credentials.enc
  recent-projects.json
  sessions/<workspace-id>/<session-id>/
  workspaces/<workspace-id>/
  plugins/
```

```bash
export NESSY_CONFIG_DIR="/custom/path/to/config"
```

Multi-instance development автоматически задает suffixed directory, например
`~/.nessy-agent-1`.

Автоматический legacy quarantine применим только к каноническому стандартному
home. Подходящий старый `~/.nessy-agent` переименовывается рядом в
`~/.nessy-agent.legacy-v1.<transactionId>`; Nessy не импортирует, не читает и не
удаляет его автоматически. Legacy или несовместимый пользовательский
`NESSY_CONFIG_DIR` блокирует запуск и остаётся нетронутым.

Внешние Project, `~/.agents` и общий Gateway-файл
`~/.nessy/dp_auth_creds.json` не перемещаются при изменении `NESSY_CONFIG_DIR` —
последний перемещает переменная [`NESSY_HOME`](#nessy-home) ниже.

### NESSY_HOME

Заменяет `~/.nessy` — каталог, в котором лежат два файла учётных данных шлюза:
`dp_auth_creds.json` (токен, который Nessy Desktop выпускает и читает) и
`oauth_creds.json` (файл nessy-cli, который Nessy Desktop читает как источник
готового токена).

```bash
export NESSY_HOME="/Volumes/work/nessy-home"
```

```
NESSY_HOME/
  dp_auth_creds.json
  oauth_creds.json
```

Четыре вещи, которые важно знать:

- **Имя переменной — не наше, и каталог тоже.** `~/.nessy` общий с nessy-cli, и
  `NESSY_HOME` — это переменная, которую для него публикует сам nessy-cli. Nessy
  Desktop поддерживает то же имя, чтобы одна настройка переносила каталог сразу
  для обоих инструментов; собственное второе имя разделило бы общий файл надвое.
- **Только абсолютные значения.** Относительный путь или путь, начинающийся с
  `~`, игнорируется, и используется каталог по умолчанию `~/.nessy`. Это сделано
  намеренно и строже, чем в nessy-cli, который раскрывает `~` и разрешает
  относительные пути от текущего каталога: этот путь обязаны одинаково вычислить
  несколько частей приложения, которые не могут переиспользовать общий код, и
  правило «абсолютный путь либо каталог по умолчанию» — единственное, в котором
  ни одна из них не ошибётся незаметно.
- **Защита чтения для агента следует за каталогом.** Запрет, по которому агент не
  может прочитать `~/.nessy`, распространяется и на перенесённый каталог, причём
  на оба сразу — прежний путь остаётся запрещённым, поэтому значение, заданное
  посреди сессии, не оставит без защиты ни одну из копий учётных данных.
- **`NESSY_CONFIG_DIR` — другой каталог и этот не переносит.** Там лежат
  конфигурация, зашифрованное хранилище учётных данных, сессии и логи; здесь —
  только два файла учётных данных шлюза.

Если вы удаляете `dp_auth_creds.json` вручную, когда эта переменная задана,
удаляйте его в каталоге, который назван в `NESSY_HOME`, — см.
[Устранение проблем со входом в шлюз](credentials#устранение-проблем-со-входом-в-шлюз).

## Developer Platform (dp)

### NESSY_DP

Задаёт бинарь `dp`, который запускает Nessy Desktop, — раньше всех мест, где он
стал бы искать его сам.

```bash
export NESSY_DP="/opt/spirit/bin/dp"
```

Что она меняет, а что нет:

- **Имя принадлежит nessy-cli.** nessy-cli публикует `NESSY_DP` для той же
  задачи и подставляет по ней плейсхолдер `${NESSY_DP}` в `command` MCP-сервера.
  Nessy Desktop уважает то же имя, чтобы один export указывал оба продукта на
  одну копию `dp`; собственное второе имя — это ровно то, как они расходятся.
- **Задавайте абсолютный путь.** Относительное значение разрешается
  относительно того каталога, из которого приложение запустилось, а это почти
  никогда не то, что имелось в виду.
- **Где Nessy Desktop ищет, по порядку, — выигрывает первый *запускаемый*:**

  1. путь из `NESSY_DP`;
  2. системный `dp`: ваш `PATH`, затем `/usr/local/bin/dp`;
  3. `CONFIG_DIR/dp/bin/dp` — в каталоге, который задаёт
     [`NESSY_CONFIG_DIR`](#nessy-config-dir). **Сегодня туда ничто не кладёт
     бинарь**: у Nessy Desktop нет загрузчика, и он никогда не устанавливает
     `dp` за вас. Место зарезервировано, чтобы порядок не пришлось менять, если
     загрузчик появится;
  4. `NESSY_HOME/dp_latest/dp` — собственная управляемая копия nessy-cli, в
     каталоге, который задаёт [`NESSY_HOME`](#nessy-home). Nessy Desktop только
     ЧИТАЕТ её и никогда не пишет, не обновляет и не удаляет: это дерево
     принадлежит nessy-cli.

  Если ни один из четырёх не запускается, вход завершается ошибкой
  [`DpNotFound`](credentials#коды-ошибок-входа).

- **Незапускаемое значение проваливается дальше, а не приводит к ошибке.** Если
  `NESSY_DP` указывает на отсутствующий файл или на файл без бита исполнения,
  Nessy Desktop переходит к следующему месту списка, а не отказывает во входе.
  Об этом ничего не сообщается, поэтому опечатка здесь выглядит ровно так же,
  как незаданная переменная: если вход работает, но не с тем `dp`, который вы
  имели в виду, проверьте, что путь существует и исполняем.
- **Устаревший `dp` обходится стороной, а не отвергается.** Как только Nessy
  Desktop увидел, что копия ниже минимальной поддерживаемой версии (13.0.0), он
  предпочитает любое другое запускаемое место списка — и всё равно использует
  старую копию, если она единственная. Порог версии предупреждает, но никогда не
  блокирует вход.
- **Состояние `dp` она не переносит — ни на одном из четырёх.**
  [`DP_WORKDIR`](#dp-workdir) выигрывает, если он задан. Иначе все места списка
  делят ваш собственный `~/.dp`, так что один вход в терминале — это вход и
  здесь; так задумано, и именно поэтому управляемая копия `dp` не получила бы
  собственный отдельный каталог состояния. Когда `~/.dp` ещё не существует,
  Nessy Desktop не передаёт каталог состояния вовсе и `dp` использует своё
  умолчание, так что первый вход, запущенный приложением, создаёт `~/.dp`, и его
  делят ваш терминал и встроенные серверы `dp ai mcp`. (До 1.41.0 приложение в
  этом случае создавало `CONFIG_DIR/dp/state`; вход, сохранённый там, больше не
  читается, поэтому в такой конфигурации войти придётся ещё раз — уже в
  `~/.dp`.) Внутри дерева [`NESSY_HOME`](#nessy-home) он не пишет никогда.

### DP_WORKDIR

Это не переменная Nessy — это собственная переменная CLI `dp`, задающая, где он
хранит своё изменяемое состояние (access/refresh токены, кэш) вместо default
`~/.dp`. Nessy Desktop читает ту же переменную (с обрезкой пробелов), чтобы
найти этот state root, и это влияет на две вещи:

- Sandboxed shell агента получает право на запись в этот каталог, так что
  команда `dp`, запущенная внутри сессии, может сама обновить свой часовой
  access token — вместо того чтобы сообщать "not authorized", пока ваш
  собственный (не sandboxed) терминал говорит, что вы авторизованы.
- [Встроенные `dp ai mcp` servers](../../sources/mcp-servers/overview#встроенные-mcp-servers)
  запускаются с тем же значением, поэтому читают токены из того же state root,
  что и остальной `dp`.

```bash
export DP_WORKDIR="/custom/dp/state"
```

Оставьте переменную не заданной, чтобы использовать default `dp` (`~/.dp`).
Nessy никогда не создаёт этот каталог сам — write grant и env встроенных
servers срабатывают только когда каталог уже существует (его создал `dp`, или
вы уже входили раньше).

### NESSY_DP_AUTH_TOKEN

Путь входа в Nessy Gateway для headless-запусков, CI и `nessy-server`. Когда
переменная задана, `dp` не используется вообще: бинарь не ищется, браузер не
открывается, и в `~/.nessy/dp_auth_creds.json` ничего не пишется.

```bash
export NESSY_DP_AUTH_TOKEN="<делегированный токен Spirit-IAM>"
```

Значение — это **сам токен**, без префикса `Bearer ` и без лишних кавычек.
Префикс `Bearer ` Nessy добавляет самостоятельно, когда предъявляет токен.

**Она сильнее всего остального.** Это первый шаг аутентификации шлюза — раньше
кэшированного файла credentials и раньше принятия токена из nessy-cli, — и
принудительный перевыпуск её не обходит. Никакая настройка приложения её не
перекрывает: чтобы вернуться к интерактивному входу, снимите переменную.

**Она не сохраняется.** Полученный по ней токен шлюза живёт только в рамках
запуска; файл credentials на этом пути не пишется и не читается.

**Плохое значение падает громко и не откатывается назад.** Headless-вызов
должен увидеть ошибку, а не молча ждать вход, который некому завершить, поэтому
недействительный или просроченный токен виден как
[ошибка входа `ExchangeFailed`](credentials#коды-ошибок-входа)
(«Не удалось обменять токен Developer Platform»).

::: warning Это не та же переменная, что у nessy-cli
У nessy-cli есть `NESSY_CLI_DP_AUTH_TOKEN`, и обе принимают делегированный токен
Spirit-IAM без префикса — то есть значение по *виду* подходит обеим. Отличается
то, что с ним происходит. nessy-cli декодирует значение локально, проверяет срок
годности и дальше использует само это значение как credential. Nessy Desktop
отправляет его на token endpoint шлюза и использует тот токен, который вернулся.

Поэтому здесь значение проверяет шлюз, а там — ваша собственная машина:
просроченный или испорченный токен выглядит в Nessy Desktop как ошибка обмена
токена, а в nessy-cli — как именованная ошибка `NESSY_CLI_DP_AUTH_TOKEN is
invalid` / `is expired`. Если вы запускаете headless оба продукта, задайте обе
переменные.

**Если задана только переменная nessy-cli, теперь об этом говорят прямо.** Когда
вход в шлюз не удаётся на машине, где задана `NESSY_CLI_DP_AUTH_TOKEN`, а эта —
нет, карточка показывает
[`CliEnvTokenOnly`](credentials#коды-ошибок-входа) вместо тех трёх ошибок,
которых эта переменная позволила бы избежать, полностью минуя `dp`: `dp` не
найден, требуется вход, вход не удался. Любая другая ошибка сохраняет свой код,
потому что заданная переменная её бы не устранила: отказ в обмене токена
так и читается как ошибка обмена токена. Больше её наличие не меняет ничего:
как credential здесь она не читается.
:::

## Behaviour flags

### NESSY_SAFE_MODE

Поставьте `1`, чтобы стартовать в safe mode: instruction files, skills,
plugins, hooks, MCP servers, custom commands и agents не загружаются — для
диагностики сломанной конфигурации. Managed policy продолжает действовать —
safe mode отключает third-party code, а не правила организации. Эквивалент
CLI-флага `--safe-mode`; напрямую порождённые child processes наследуют
переменную.

```bash
export NESSY_SAFE_MODE=1
```

### NESSY_SUBAGENT_MODEL

Модель по умолчанию для subagents и workflow agents, которым модель не задана
иначе, на всех runtime. Модель, переданная для одного вызова, или `model` из
определения subagent (включая `inherit`) по-прежнему важнее неё. Чтобы
применить эту модель ко всем subagents, дополнительно задайте
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (fork по-прежнему работает на модели
основного разговора). Значение `inherit` возвращает обычную резолюцию модели.

```bash
export NESSY_SUBAGENT_MODEL="tgpt/qwen36-35b-a3b-fp8"
```

### NESSY_ENABLE_TELEMETRY

Поставьте `1`, чтобы opt-in в OpenTelemetry usage metrics. Также нужен OTLP
endpoint через стандартную переменную `OTEL_EXPORTER_OTLP_ENDPOINT`; без
opt-in ничего не экспортируется. Telemetry псевдонимна — reported identity
ключуется per-install солью из credential store.

### Telemetry opt-out

Три стандартных имени выключают telemetry, и они сильнее opt-in выше — на любом
runtime, Pi, Claude и Codex одинаково, потому что exporters живут на хосте, а не
внутри рантайма. Ничего не экспортируется и per-install соль не создаётся.

| Variable | Правило |
| --- | --- |
| `DO_NOT_TRACK` | Cross-industry convention. Читается как boolean: `1`/`true` — opt-out, `0` оставляет telemetry включённой |
| `DISABLE_TELEMETRY` | Читается только по факту установки: любое непустое значение — opt-out, включая `0` и `false`. Чтобы вернуть telemetry, переменную надо снять |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | То же правило «установлена или нет», как более широкий выключатель nonessential traffic |

Per-signal селекторы OpenTelemetry работают рядом с ними:
`OTEL_METRICS_EXPORTER=none` глушит usage metrics, а `OTEL_LOGS_EXPORTER=none` —
harness events, каждый не задевая другой.

### Disable switches

| Variable | Поставьте `1`, чтобы |
| --- | --- |
| `NESSY_DISABLE_BACKGROUND_TASKS` | Выключить background tasks, включая автоматический перевод долгих команд и MCP-вызовов в фон |
| `NESSY_DISABLE_CRON` | Выключить создание и доставку scheduled tasks внутри sessions |
| `NESSY_DISABLE_WORKFLOWS` | Убрать workflow tool, workflow slash commands и keyword trigger |
| `NESSY_DISABLE_BUNDLED_SKILLS` | Убрать bundled skills и workflows, поставляемые с приложением; ваши собственные skills и plugin skills не затрагиваются. В сессии Codex это также отключает собственные bundled skills Codex (`[skills.bundled] enabled = false`), включая `$skill-installer` |

Эти переменные компонуются с соответствующими settings keys по принципу
tighter-wins: выигрывает та сторона, которая просит off.

### NESSY_LOCAL_MCP_ENABLED

Включает или выключает local MCP servers (stdio-subprocess kind), имея
приоритет над настройками каждого workspace.

```bash
export NESSY_LOCAL_MCP_ENABLED="false"
```

Значение сравнивается case-insensitively: любое значение, равное `true`
(ignoring case), включает local MCP servers; все остальное выключает их. Если
переменная не задана, local MCP servers включены по умолчанию.

### NESSY_PLUGIN_GITLAB_HOSTS

Дополнительные hostnames self-hosted GitLab, с которых разрешено забирать
[plugin installs](../../plugins/overview). Разделяйте запятыми или пробелами;
hostnames сравниваются case-insensitively.

```bash
export NESSY_PLUGIN_GITLAB_HOSTS="gitlab.internal.example.com, code.example.net"
```

Каждый объявленный host идёт по документированному GitLab v4 archive route,
который строится из origin самого repository URL. `gitlab.com`, любой hostname,
где `gitlab` — целый DNS label, и собственный git host этого форка резолвятся
без объявления; переменная нужна для тех, чьи имена про GitLab не говорят.

Она объявляет **только** GitLab hosts. Host GitHub Enterprise Server здесь
объявить нельзя, и это намеренно: archive route у него совпадает, но
резолвинг tags жёстко прошит на `api.github.com`, поэтому объявленный GHES host
молча резолвил бы свои tags против чужого сервера.

Администратор может задать список для всего парка машин из блока `env` в
[managed settings](config-file) — переменная классифицирована как immediate
managed value, то есть применяется на старте, и вручную экспортировать её никому
не нужно.

### NESSY_MCP_TIMEOUT

Startup deadline для подключения одного MCP server, в миллисекундах. Default —
`30000` (30 секунд). Поднимите его, если stdio server раз за разом падает на
старте из-за медленного первого запуска — обычно пока `npx` или `uvx`
скачивает пакет.

```bash
export NESSY_MCP_TIMEOUT="60000"
```

Значение должно быть положительным целым числом; всё остальное откатывается к
default. Deadline бюджетирует весь initial connect, включая все 3 connect
attempts — а не каждую попытку отдельно, — так что задавайте его с учётом всей
retry chain. Явный programmatic connect timeout, там где он настроен, имеет
приоритет над этой переменной.

### NESSY_STOP_HOOK_BLOCK_CAP

Сколько раз подряд block reason от `Stop`- или `SubagentStop`-hook
переотправляется модели, прежде чем он будет подавлен и turn всё равно
завершится. Default — `8`. Поднимите его, если hook действительно требует
больше итераций, чтобы сойтись; `0` полностью снимает cap.

```bash
export NESSY_STOP_HOOK_BLOCK_CAP="20"
```

Значение должно состоять только из цифр; всё остальное откатывается к `8` —
опечатка не может незаметно превратиться в hook loop без ограничения.
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` принимается как compatibility alias, и при
одновременно заданных значениях побеждает написание Nessy.

### NESSY_MAX_WEB_SEARCHES_PER_SESSION

Сколько web searches одна session может выполнить собственным tool приложения
`web_search`. Default — `200`. После cap поиск возвращает notice, которое
просит модель продолжить с уже собранной информацией, а не ошибку, которая
провоцировала бы повтор.

```bash
export NESSY_MAX_WEB_SEARCHES_PER_SESSION="500"
```

Значение должно быть положительным целым числом без верхней границы; всё
остальное откатывается к `200`, а `0` не выключает cap — его можно поднять, но
нельзя снять. `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` принимается как
compatibility alias, и при одновременно заданных значениях побеждает написание
Nessy.

На card **ChatGPT (Codex)** модель ищет собственным web search Codex вместо tool
приложения, а у Codex нет лимита на session, поэтому там этот cap поиск не
останавливает. Приложение считает поиски Codex в этой session, включая её
subagents, и на первом поиске сверх cap один раз сообщает об этом в чате. См.
[LLM Connections → ChatGPT (Codex)](./llm-connections#chatgpt-codex).

### NESSY_WEB_SEARCH_ALLOWED_DOMAINS

Домены, из которых web search может возвращать результаты. Если переменная не
задана (default), поиск не ограничен. Разделяйте записи запятыми или пробелами.
Сам web search не требует одобрения ни в одном режиме и ни на одном runtime;
отключить его можно deny rule, называющим search tool (см.
[Permissions](/ru/core-concepts/permissions)).

```bash
export NESSY_WEB_SEARCH_ALLOWED_DOMAINS="example.com, docs.python.org"
```

Каждая запись разрешает свой host и все его subdomains: `example.com` разрешает
`docs.example.com`, но не `notexample.com`. Записи сравниваются
case-insensitively и могут быть написаны как адрес: scheme, port, path и
ведущая точка игнорируются, так что `https://Example.com/docs` означает
`example.com`. Пустое значение ничего не фильтрует — так же, как незаданное.
Compatibility alias `CLAUDE_CODE_` нет: у Claude Code такой переменной нет.

Результаты вне списка отбрасываются до того, как их увидит модель, как и
результат, адрес которого не удаётся прочитать. Если у поиска были результаты и
все они отброшены, он возвращает notice, которое называет эту переменную и
просит модель продолжить с тем, что у неё есть, или попросить вас расширить
список, а не пустой ответ.

Где она действует:

- **Pi**: собственный tool Pi `web_search`.
- **Claude Code** и **Codex**: собственный tool приложения `web_search`,
  который эти runtimes получают там, где их собственный поиск работать не
  может, — на Nessy Gateway, на custom endpoint, доступном через chat
  completions, и на всех Codex cards, кроме ChatGPT (Codex).
- **ChatGPT (Codex)**: список передаётся собственному web search Codex как
  домены, которыми он может пользоваться, и применяет его сам Codex по своим
  правилам сопоставления; notice приложения, описанное выше, там не
  появляется. См.
  [LLM Connections → ChatGPT (Codex)](./llm-connections#chatgpt-codex).
- **Собственный `WebSearch` Claude Code** там, где session его сохраняет, — с
  аккаунтом Anthropic или с моделью, которую custom endpoint обслуживает на
  [wire Anthropic](./custom-endpoint#модели-на-wire-anthropic): этот поиск
  выполняется на стороне provider, поэтому приложение ограничивает каждый
  вызов, а не фильтрует результаты. Каждый поиск сужается до списка через
  собственный input tool `allowed_domains`. Если модель сама ограничила поиск
  своими hosts, остаются только те из них, что входят в список; если ни один не
  входит, поиск отклоняется с сообщением, которое называет эту переменную.
  Исключённые моделью домены из такого вызова убираются, потому что Claude Code
  не может совместить два вида списка в одном поиске; результаты всё равно
  приходят только из разрешённых вами доменов. Provider сопоставляет домены по
  своим правилам, и notice, описанное выше, там не появляется.

Администратор может задать список для всего парка машин из блока `env` в
[managed settings](config-file); он применяется на старте.

### NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT

Что делает session, когда usage limit останавливает turn, а время сброса лимита
известно. Включено (default) — session ждёт сброса и продолжает задачу; `0` —
turn вместо этого останавливается. Если время сброса не опубликовано, turn
останавливается независимо от этой настройки: приложение никогда его не
угадывает.

```bash
export NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT="0"
```

Принимает `1`/`true`/`yes`/`on` и `0`/`false`/`no`/`off`; всё остальное
оставляет default. Что делает с ней каждый runtime:

- **Claude Code**: приложение передаёт ответ собственной настройке Claude Code
  `autoContinueAtUsageLimit`, и ждёт сам Claude Code (пока session использует
  overage, он не ждёт).
- **Codex**: Codex останавливается на usage limit и сам остановленный turn не
  продолжает, поэтому здесь настройка меняет только сообщение. Включена — оно
  называет время сброса и просит отправить сообщение после него; `0` — говорит,
  что turn останавливается, а не ждёт.
- **Pi**: не читает её.

### NESSY_IDLE_AGENT_TTL_MS

Сколько диалог может простоять без начатых и завершённых ходов, прежде чем его
агент будет освобождён. По умолчанию: `1800000` (30 минут). Следующее сообщение
поднимет его заново, диалог останется целым — цена освобождения — время на
старт, а не тред.

```bash
export NESSY_IDLE_AGENT_TTL_MS="600000"
```

`0`, отрицательное или нечисловое значение **выключает** освобождение полностью;
это выключатель, и он намеренно не читается как «освобождать всё». Диалог,
который что-то держит, не освобождается при любом значении: идущий ход, фоновая
задача, фоновая команда, дочерний агент, ожидающая карточка разрешения или
неотвеченный вопрос — а также диалог, который слушает то, что перестанет
слышать.

### NESSY_IDLE_AGENT_SWEEP_MS

Промежуток между проверками простоя. По умолчанию: `60000` (1 минута). Одна
проверка на всё приложение, а не таймер на диалог. `0` возвращает значение по
умолчанию, а не крутит цикл.

### NESSY_DEBUG

Включает debug logging. Принимает `"true"` или `"1"`.

```bash
export NESSY_DEBUG="true"
```

### NESSY_DEEPLINK_SCHEME

Переопределяет deep-link URL scheme. Default — `nessy` (deep links выглядят как
`nessy://...`). Multi-instance development использует suffixed schemes вроде
`nessy1`.

```bash
export NESSY_DEEPLINK_SCHEME="nessy1"
```

### NESSY_BROWSER_DOWNLOAD_DIR / NESSY_BROWSER_DOWNLOAD_ASK

Куда попадает файл, скачанный во встроенном браузере. Если ни одна переменная не
задана, скачивания по-прежнему идут в `downloads` внутри сессии и без диалога —
поведение не меняется.

`NESSY_BROWSER_DOWNLOAD_DIR` принимает АБСОЛЮТНЫЙ путь к директории, и каждое
скачивание попадает туда; относительное значение игнорируется и пишется в лог.
`NESSY_BROWSER_DOWNLOAD_ASK` принимает `1`/`true`/`yes`/`on` и заставляет браузер
показывать системный диалог сохранения для каждого скачивания, начиная с
директории выше, если она задана.

```bash
export NESSY_BROWSER_DOWNLOAD_DIR="/Users/me/Downloads/nessy"
export NESSY_BROWSER_DOWNLOAD_ASK="1"
```

## Server mode

Эти переменные настраивают [headless server](../../server/headless) и его
clients.

### NESSY_SERVER_TOKEN

Bearer token, который authenticates RPC link. Оба конца — server и client —
должны задать одно и то же значение.

```bash
export NESSY_SERVER_TOKEN=$(openssl rand -hex 32)
```

### NESSY_SERVER_URL

Server URL, к которому подключается client.

```bash
export NESSY_SERVER_URL=wss://your-server:9100
```

### NESSY_RPC_HOST

Interface, к которому bind server. Если переменная не задана, используется
`127.0.0.1`, доступный только с local machine; используйте `0.0.0.0`, чтобы
разрешить remote clients.

```bash
export NESSY_RPC_HOST=0.0.0.0
```

### NESSY_RPC_PORT

Server port. Default — `9100`.

```bash
export NESSY_RPC_PORT=9100
```

### NESSY_RPC_TLS_CERT / NESSY_RPC_TLS_KEY

Paths к TLS certificate и private key, оба в PEM. Они нужны remote (`wss://`)
clients; localhost-only dev setup может обойтись без них.

```bash
export NESSY_RPC_TLS_CERT=/path/to/cert.pem
export NESSY_RPC_TLS_KEY=/path/to/key.pem
```

### NESSY_RPC_TLS_CA

Optional PEM CA chain для custom certificate authorities.

```bash
export NESSY_RPC_TLS_CA=/path/to/ca.pem
```

## Networking

### HTTP_PROXY / HTTPS_PROXY / NO_PROXY

Standard proxy variables. Nessy Desktop выводит их из in-app
[network proxy](network-proxy) settings и передает в agent subprocesses; lowercase
forms тоже задаются.

Приложение их и читает. Когда in-app proxy выключен, proxy, заданный здесь (на
macOS — в том числе в вашем login shell), несёт собственные requests
приложения, включая model requests sessions Codex и Claude Code на gateway и
custom-endpoint cards, а `env`-блок managed
settings, который задаёт proxy, важнее in-app настройки — см.
[Network Proxy → Как это работает](network-proxy#как-это-работает).

Launcher headless server `bin/nessy-server`, запущенный с одной из этих
переменных, дополнительно экспортирует `NO_PROXY` (и `no_proxy`), расширенный
на `localhost,127.0.0.1,::1,[::1]`. Заданные вами entries сохраняются, поэтому
собственные requests server к этой машине никогда не идут через proxy. Server,
запущенный из checkout, такого расширения не получает и вместо этого
предупреждает — см. [Headless Server → Запуск server](../../server/headless#запуск-server).

### NODE_EXTRA_CA_CERTS

Указывает Node-based processes на additional CA certificate — это нужно за
TLS-intercepting corporate proxy. См.
[Network Proxy → TLS-intercepting proxies](network-proxy#tls-intercepting-proxies-corporate-firewalls).

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

## Installer variables

Скрипт установки macOS читает эти переменные:

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `NESSY_DESKTOP_INSTALL_BASE`   | Base URL of the release feed                           |
| `NESSY_DESKTOP_INSTALL_VERSION`| Pin a specific version to install                      |
| `NESSY_DESKTOP_DOWNLOAD_DIR`   | Where downloaded DMGs are cached (default under `~/.nessy-agent/downloads`) |

## Release and docs tooling

- `NESSY_DESKTOP_UPDATE_URL` и `NESSY_DESKTOP_UPDATE_CHANNEL` питают local
  Electron packaging.
- `NESSY_DESKTOP_DOCS_BUCKET` и `NESSY_DESKTOP_DOCS_URL` переопределяют
  documentation publish target.
- S3 publish credentials передаются только protected CI variables на protected
  refs; вручную они не задаются.

## Security note

::: warning
Не кладите secrets напрямую в shell history или committed scripts. Читайте их
из файла или secret manager:

```bash
export LLM_API_KEY=$(cat ~/.secrets/llm-key)
```
:::
