# Файл конфигурации

Файл `config.json` хранит несекретное состояние уровня приложения Nessy Desktop:
список workspaces, LLM connections, default connection, настройки Appearance и
input, а также необязательную конфигурацию network proxy. Secrets здесь никогда
не хранятся — они находятся в [зашифрованном credential store](credentials).

## Расположение

`CONFIG_DIR` равен `NESSY_CONFIG_DIR`, если переменная задана, иначе —
`~/.nessy-agent`:

```
CONFIG_DIR/config.json
```

См. [Environment Variables](environment-variables). Multi-instance development
использует каталоги с суффиксами, например `~/.nessy-agent-1`.

В этом же каталоге находятся:

| File / folder                | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `config.json`                | Состояние приложения, описанное на этой странице            |
| `preferences.json`           | Личные [preferences](preferences)                           |
| `credentials.enc`            | Зашифрованный [credential store](credentials)               |
| `config-defaults.json`       | Встроенные значения по умолчанию, обновляются при запуске   |
| `recent-projects.json`       | История внешних Project по непрозрачным ID, управляемая backend |
| `sessions/<workspace-id>/`   | Глобальный раздел диалогов одной Workspace                  |
| `workspaces/<workspace-id>/` | Конфигурация и управляемые ресурсы Workspace                |
| `plugins/`                   | Реестр, неизменяемый cache и scoped data плагинов           |
| `logs/`                      | Логи auto-update и main process                             |

На macOS лог Electron main process записывается в
`~/Library/Logs/Nessy Desktop/main.log`.

## Структура

```json
{
  "storageLayoutVersion": 2,
  "llmConnections": [
    {
      "slug": "nessy-gateway",
      "name": "Nessy Gateway",
      "providerType": "pi_compat",
      "authType": "bearer_token",
      "piAuthProvider": "openai",
      "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
      "defaultModel": "tgpt/deepseek-v4-flash-0731",
      "createdAt": 1737451800000
    }
  ],
  "defaultLlmConnection": "nessy-gateway",
  "workspaceRefs": [
    {
      "id": "ws-abc123",
      "lastAccessedAt": 1737538200000
    }
  ],
  "activeWorkspaceId": "ws-abc123",
  "activeSessionId": "260121-swift-falcon",
  "notificationsEnabled": true,
  "colorTheme": "default"
}
```

## Поля верхнего уровня

### llmConnections

Массив записей [LLM connection](llm-connections). Каждая запись описывает одну
настройку provider — встроенный Nessy Gateway, прямое подключение Anthropic,
Claude subscription login или ChatGPT login (card ChatGPT Plus (Pi) или
ChatGPT (Codex)). Здесь хранится только несекретная routing metadata; API keys
и OAuth tokens лежат в credential file и привязаны к `slug` connection.

### defaultLlmConnection

Slug connection для новых сессий, когда ни session, ни workspace не закрепляют
свою connection. Если поле отсутствует, fallback — первая запись в
`llmConnections`.

### defaultThinkingLevel

Глобальный default thinking level для новых сессий на моделях, которые его
поддерживают.

Уровень, выбранный для модели, ещё и запоминается за этой моделью, и
запомненный уровень старше этого глобального default. Запоминает сам выбор:
достаточно один раз выбрать thinking level в model picker — и следующий диалог
на этой модели начнётся с него, одинаково на Pi, Claude Code и Codex, потому что
память хранится здесь, а не у того рантайма, которому досталось запустить
модель. Уровень, заданный для текущего диалога, для этого диалога по-прежнему
главнее. Если для модели ничего не запомнено и глобальный default не задан,
модель, чей каталог публикует собственный рекомендованный effort, стартует с
него.

### workspaceRefs

Упорядоченные ссылки на настроенные Workspace. Имя, defaults, timestamps,
локальная MCP policy и remote binding хранятся в
`CONFIG_DIR/workspaces/<workspace-id>/config.json`.

```json
{
  "id": "ws-abc123",
  "lastAccessedAt": 1737538200000
}
```

| Field            | Required | Description                              |
| ---------------- | -------- | ---------------------------------------- |
| `id`             | Yes      | Неизменяемый идентификатор Workspace     |
| `lastAccessedAt` | Yes      | Время последнего доступа для сортировки  |

Конфигурация Workspace может содержать remote binding без секрета:

```json
{
  "id": "ws-abc123",
  "name": "Personal",
  "defaults": {},
  "remoteServer": {
    "url": "wss://nessy.example.internal",
    "remoteWorkspaceId": "remote-ws-42"
  }
}
```

Токен remote Workspace находится только в `credentials.enc`. Необязательный
Project по умолчанию — внешний `workingDirectory`, а не хранилище Workspace. UI и RPC
выбирают его через непрозрачный backend handle; server заново проверяет
идентичность Project перед использованием. `recent-projects.json` — только
удобная история, а не авторизация.

Как создаются и используются workspaces, см. в
[Workspaces](../../go-further/workspaces).

### activeWorkspaceId

Идентификатор workspace, выбранного при запуске, или `null`, если workspace не
выбран.

### activeSessionId

Идентификатор выбранной сессии внутри `activeWorkspaceId` или `null`. Вместе эти
два поля образуют активную пару `{ workspaceId, sessionId }`. Сессии находятся в
`CONFIG_DIR/sessions/<workspace-id>/<session-id>`, а не внутри каталога ресурсов
Workspace.

### notificationsEnabled

Включает desktop notifications для событий completion. Значение по умолчанию —
`true`.

### colorTheme

Идентификатор выбранной preset theme, например `"dracula"` или `"nord"`.
Значение по умолчанию — `"default"`.

### networkProxy

Необязательные настройки HTTP/HTTPS proxy. Форму полей и поведение см. в
[Network Proxy](network-proxy).

### dismissedUpdateVersion

Версия, которую пользователь решил пропустить. Когда поле задано, app перестает
напоминать именно об этом release.

### Sessions, retention и context

| Key | Default | Purpose |
| --- | --- | --- |
| `outputStyleId` | — | Активный output style для новых sessions |
| `retentionDays` | `30` | Сколько дней хранить session data до age-based sweep (минимум 1) |
| `retentionSweepEnabled` | `true` | Явный `false` полностью выключает sweep, независимо от окна |
| `autoCompactEnabled` | `true` | Автоматическая context compaction; ручной `/compact` работает в любом случае |
| `askUserQuestionTimeout` | `"never"` | Idle-время, после которого неотвеченный вопрос агента auto-continues с уже сделанным выбором: `"60s"`, `"5m"`, `"10m"` или `"never"` |
| `sessionMirror` | — | Best-effort зеркалирование transcript в adapter (`{ "adapter": "directory", "path": "/abs/path" }`); локальный диск остаётся authoritative |
| `extendedPromptCache` | `false` | 1-часовой prompt-cache TTL вместо 5 минут |
| `enable1MContext` | — | **Игнорируется с 1.41.0**, но по-прежнему принимается, чтобы старый файл загружался. Переключателя больше нет: каждая модель работает со своим контекстным окном, и модель Claude с окном 1M токенов его получает. Чтобы ограничить окно, оператор задаёт в окружении `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (200K) или `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| `memoryEnabled` | `true` | Auto-memory заметки, сохраняющиеся между sessions |
| `reopenCompactPromptTokens` | `100000` | Размер в токенах, выше которого повторное открытие давно неактивного разговора предлагает *Возобновить по сводке* или *Возобновить целиком*. **Ноль или отрицательное число выключает диалог** — это и есть поддерживаемое «больше не спрашивать», а не ошибка |
| `sessionAgent` | — | Имя агента, **которым** работает новая сессия: его system prompt и его ограничения инструментов действуют на весь разговор, а не только на порождённых детей. В композере рядом с режимом появляется `@<имя>`. Имя, которому не соответствует ни один агент воркспейса, сообщается там, где ростер известен, а не здесь |
| `crossSessionInbound` | не задано | Что сессия делает с текстом, приходящим из ваших других сессий: `"accept"`, `"hold"` (придержать до вашего решения) или `"refuse"`. Не заданное значение оставляет умолчание на уровне сообщения. Нераспознанное значение **игнорируется и о нём сообщается** — пока оно там, сообщения придерживаются, а исправление их отпускает. `NESSY_CROSS_SESSION_INBOUND` позволяет оператору задать это для машины, и селектор в приложении прячется, когда эта переменная выставлена |
| `lastReviewEffortLevel` | — | Уровень усилий, на котором прошёл последний `/code-review`, `/simplify` или `/security-review`, чтобы он не забывался каждую сессию. Пишется приложением; одно из значений thinking level |

### Agent execution и safety

| Key | Default | Purpose |
| --- | --- | --- |
| `sandbox` | — | Sandbox settings для supervised выполнения команд. **`enabled` — главный выключатель, default `false`** (owner decision 2026-08-12: выключено до подтверждения стабильности агентского цикла без обёртки), поэтому на свежей установке ни одна supervised-команда не получает OS-level изоляцию (seatbelt/bwrap/firejail/Windows-профиль). Managed policy, задающая `enabled`, побеждает безоговорочно в любую сторону — в отличие от `allowUnsandboxedCommands` ниже, managed floor здесь не просто lock, который user-значение не может ослабить. Чтобы вернуть изоляцию, установите `sandbox.enabled: true` в user или managed settings. Path-контролы вложены в `sandbox.filesystem`: `allowWrite`, `denyWrite`, `denyRead`, `allowRead`, `allowManagedReadPathsOnly`, `disabled`. Плоские формы `additionalWritableRoots`, `deniedWriteRoots` и `deniedReadRoots` остаются принимаемыми алиасами первых трёх; если написать оба варианта, записи объединяются, а не заменяют друг друга. Рядом — glob patterns `excludedCommands`, работающие вне изоляции, lock escape-hatch `allowUnsandboxedCommands` и блок `network` (`allowedDomains`, `deniedDomains`, `allowManagedDomainsOnly`). Префиксы путей: `/tmp/build` — абсолютный путь, **не** относительный к проекту; `~/.kube` разворачивается от домашней директории; `./out` или просто `out` — от config-директории (`~/.nessy-agent`); старая форма `//tmp/build` по-прежнему работает и нормализуется в `/tmp/build`. Запись, которая разворачивается в корень файловой системы, отклоняется. Managed policy layer merge-ится поверх этого — у него нет config-директории для привязки, поэтому запись `./` или без префикса там отбрасывается с явной причиной. Единственное исключение — сессионный инструмент `script_sandbox` сохраняет собственную изоляцию безусловно, независимо от `sandbox.enabled`. Известное ограничение на macOS при `sandbox.enabled: true`, измеренное на Pi: headless Chromium, запущенный командой Pi внутри sandbox (например, `chrome-headless-shell` из Playwright), падает при старте с segmentation fault в IOKit, потому что профиль изоляции macOS в Nessy не даёт Chromium того, что нужно ему для запуска; перечислите такие команды в `excludedCommands` — это выход для Pi (Claude Code и Codex выполняют команды в собственных sandbox, `excludedCommands` ни одному из них не передаётся, и там это падение не измерялось) — или оставьте главный переключатель выключенным |
| `macosSeatbeltBashSandboxEnabled` | off | macOS Seatbelt изоляция для Bash-команд. Подчинён `sandbox.enabled`: пока главный выключатель выключен, `true` этого ключа не действует — он сохраняет смысл только пока главный выключатель включён |
| `worktree` | — | Настройки session worktree: `baseRef` (`"fresh"` или `"head"`), `symlinkDirectories`, `sparsePaths` и `bgIsolation` (`"worktree"` или `"none"`) |
| `workflow` | — | Workflow governance: `disableWorkflows` (жёсткий off switch; org-level `true` нельзя включить обратно локально), `sizeGuideline` (совет, не cap), `keywordTriggerEnabled` |
| `additionalDirectories` | `[]` | Дополнительные absolute filesystem roots, куда tools могут писать помимо root-ов session; расширение root — permission decision |
| `primaryDirectory` | — | Какая из уже подключённых папок показывается и сортируется первой. Задаётся в **Settings → Permissions**, где select перечисляет только подключённые папки. Это выбор **отображения и порядка**: resolver может ответить лишь папкой, которая уже подключена, поэтому никакое значение здесь не расширяет то, что агент может читать и писать, а discovery по-прежнему идёт от project root. Чтобы добавить root, используйте `additionalDirectories` или approval на выход за root |
| `guardianEnabled` | `true` | Консультировать guardian safety judge для borderline (`auto`) и high-risk (`bypassPermissions`) actions. Работает для сессий runtime Pi |
| `guardianJudgeModels` | `{}` | Модель judge **на каждый slug подключения** (`{ "<slug>": "<modelId>" }`), задаётся в Settings в секции Guardian. Порядок разрешения: запись этого подключения → legacy-global `guardianJudgeModelId`, если он валиден на этом подключении → gateway alias `fast` → модель session. Устаревшая или запрещённая запись **проваливается дальше**, а не роняет проверку: ограничение по моделям не должно превращаться в снижение безопасности. Пустой id удаляет запись |
| `guardianJudgeModelId` | — | Legacy-global модель judge. По-прежнему читается, миграции нет; запись для подключения его перекрывает |
| `useAutoModeDuringPlan` | `true` | Разрешить safe-command classifier проверять shell-команды Plan-режима вместо prompt. Читается только сессиями runtime Pi (P3.187) — `claude-runtime` и `codex-runtime` classifier для этой полосы не вызывают. Даже на Pi проверка происходит, только если guardian вернул вердикт; при любом другом исходе, как и на двух других runtime, shell-команда Plan-режима вне read-only набора выдаёт prompt — документированная ветка "Otherwise". Измерено вживую на packaged-сборке (PKG-6, 2026-09-03): при значении по умолчанию `mkdir -p` дошла до человека на всех трёх |
| `rtkEnabled` | `false` | Гнать Bash-команды через `rtk` для компрессии tool output (сессии Pi и Claude Code; `rtk` 0.44.0 или новее — см. [Performance](../../go-further/performance)) |
| `rtkExcludeCommands` | `[]` | Имена базовых команд, которые никогда не передаются в `rtk`, — для инструментов, вывод которых всегда нужен дословно (`["grep", "jq"]`). Читается при каждой команде |
| `decisionLayer` | выкл. | Необязательная [модель решений](../../core-concepts/decision-model): главный переключатель, провайдер, адрес, модель и переключатели функций. Задаётся в **Настройки → AI → Модель решений (Jev)**; ключ хранится в хранилище учётных данных, а не здесь |
| `mcpChannelPushEnabled` | `false` | Push channel updates для MCP clients |
| `blockReadsOutsideWorkingDirectories` | `false` | Граница на чтение, симметричная границе на запись. Забор поднимает только буквальный `true`, всё остальное оставляет его опущенным. Действует во **всех** режимах разрешений, включая Bypass. При опущенном заборе auto-режим всё равно спрашивает один раз при первом чтении за пределами рабочих каталогов сессии, и ответ *Блокировать впредь* на этой карточке как раз и записывает сюда `true` |
| `codexAutoReviewEnabled` | `false` | Включает собственного проверяющего Codex на основе модели для согласований, которые Codex иначе эскалировал бы вам: когда действие требует согласования, Codex сначала спрашивает проверяющего, а не отвлекает вас. Отказ можно отменить командой `/approve`, а череда отказов прерывает ход. **Пока он включён, проверяющий может одобрить и то, что приложение иначе отклонило бы или всегда показывало вам**, — защитные ограничения приложения (в том числе удаление домашней или корневой папки), запрещённые вами пути и любое запрещающее правило, которое Codex не применяет сам, — потому что Codex спрашивает проверяющего раньше, чем это приложение. Проверяющий отвечает только в режимах Auto («Авто») и Bypass permissions («Обход разрешений») — в Manual, Accept edits и Plan согласование приходит вам, а Don't ask («Не спрашивать») его отклоняет, — а изменение действий или расписания автоматизации без присмотра отклоняется, а не проверяется (если Codex не может выполнить эту проверку, ход сообщает об этом, и решает проверяющий). Если политика Codex вашей организации разрешает только проверяющего, решает она: проверяющий отвечает и в Manual, Accept edits и Don't ask («Не спрашивать»), Codex отклоняет ходы Plan, и сессия сообщает об этом. Выключение действует со следующего сообщения в открытых сессиях Codex; включение и изменение `codexAutoReviewPolicy` действуют в сессиях Codex, начатых после этого. Только для сессий Codex. Оба контрола есть в **Settings → AI**; значение, заданное здесь в файле, действует так же |
| `codexAutoReviewPolicy` | `""` | Необязательный текст инструкции, передаваемый этому ревьюеру |
| `codexSubagentsEnabled` | `true` | Разрешает session на Codex порождать собственные agents. Default совпадает с собственным default Codex; передаётся только явный `false` — как `[agents] enabled = false` в config-файле, который приложение отдаёт runtime. Переключатель — в **Settings → AI**. Условность заявлена в самом контроле: включённый `features.multi_agent_v2` в собственной конфигурации Codex имеет приоритет над этим ключом |

### Настройки без контрола в приложении

У них есть reader, запись в strict-envelope и тесты — и ни одного контрола в
приложении, намеренно: это ключи operator-уровня, поэтому они показываются в
`nessy-general-agent doctor` (секция *Settings with no in-app control*) и в
Settings → Диагностика настроек, а не рядом с выбором модели. **Ни у одного из
них нет managed-слоя и переопределения через окружение**: значение ниже — это
весь ответ.

| Ключ | По умолчанию | Где задаётся | Назначение |
| --- | --- | --- | --- |
| `claudeExplorePlanAgentsEnabled` | не задано | `config.json` | Явный `false` убирает собственные субагенты claude Explore и Plan из ростера (выставляется `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`). Не заданное значение оставляет умолчание рантайма, то есть включено — «не задано» это **не** то же самое, что `true`, и переносится только явный `false` |
| `claudeSwitchModelsOnFlag` | не задано | `config.json` | Явный `false` запрещает вендорному SDK молча переигрывать помеченный классификатором ход на другой модели. Не заданное значение оставляет умолчание SDK, то есть включено |
| `systemPromptAppend` | — | `config.json` | Текст, дописываемый к system prompt основной модели на всех трёх рантаймах. Только дописывание: заменяющего ключа нет и не будет |
| `fileCheckpointingEnabled` | `true` | `config.json` | Включает или выключает файловые снимки, которые восстанавливает `/rewind`. Написание взято у Claude, реализация host-side. Ключ управляет всеми тремя runtimes: Pi и Codex делают снимки сами — Codex по собственному pre-write-объявлению `fileChange`, поэтому rewind на Codex восстанавливает правки хода, а `/diff` их показывает, — а Claude Code делает свои под той же настройкой |
| `sessionAllowedTools` | `[]` | `config.json` | Whitelist инструментов сессии. Пустой список означает отсутствие ограничения. **Claude Code:** сужает встроенные инструменты сессии до перечисленных плюс `ToolSearch`, который приложение оставляет, чтобы MCP tools по-прежнему подгружались по требованию. MCP tools он не ограничивает (для них — `sessionDisallowedTools`), а scoped-правило вроде `Bash(ls:*)` инструмент не сохраняет: указывайте голое имя. `nessy-general-agent doctor` называет каждую запись, которую Claude Code игнорирует, и причину. Что разрешено перечисленному инструменту, по-прежнему решают ваш режим и правила. **Pi:** весь список инструментов, включая MCP tools, так что перечислите все, которыми session может пользоваться. **Codex:** не применяется — у Codex нет настройки, сужающей его встроенные инструменты |
| `sessionDisallowedTools` | `[]` | `config.json` | Инструменты, убранные из сессии. Пустой список означает отсутствие ограничения. Только Claude Code: список добавляется к инструментам, которые приложение и так не даёт, и может называть MCP tools (`mcp__<server>__*`). Pi и Codex его не применяют |

::: tip
Эти два ключа переехали в `config.json` и теперь работают. До этого они читались
из `workspaceDefaults` в `config-defaults.json`, а этот файл **не
пользовательский**: Nessy перезаписывает вашу копию бандловым ассетом при каждом
запуске, и в бандле нет ни одного из этих ключей — поэтому вписанное руками
значение исчезало при следующем старте, и на любой установке оба разрешались в
пустой список. Если вы что-то туда вписывали, перенесите это в `config.json`:
ничего не мигрируется, потому что ни одна такая запись не могла пережить
перезапуск.
:::

### Другие флаги UI и поведения

`config.json` также хранит небольшие toggles из Settings: input options
(`autoCapitalisation`, `sendMessageKey`, `spellCheck`), appearance
(`zoomFactor`), power settings (`keepAwakeWhileRunning`) и tool metadata
(`richToolDescriptions`, `browserToolEnabled`). Обычно ими управляют через
Settings, а не вручную.

Workspace `config.json` files также могут хранить agent lifecycle `hooks` и
workspace defaults — permission mode, thinking level и ротацию Shift+Tab
(`cyclablePermissionModes`, минимум два режима). Это workspace-scoped setting,
а не global app secret store; форму hook и более безопасную альтернативу
`hooks.json` см. в
[Automations](../../automations/overview#lifecycle-hook-config).

## Переход на storage v2 и backups

Nessy работает только с layout v2. На стандартном пути подходящий
неверсионированный или v1-каталог `~/.nessy-agent` переименовывается рядом в
`~/.nessy-agent.legacy-v1.<transactionId>`, после чего создаётся чистый v2 home.
Карантин инертен: Nessy не импортирует и не читает из него settings, sessions,
plugins, skills или `credentials.enc` и никогда не удаляет его автоматически.
Сохраняйте или удаляйте этот соседний каталог вручную только вне автоматического
перехода.

Legacy или несовместимый пользовательский каталог `NESSY_CONFIG_DIR` блокирует
запуск и остаётся нетронутым; такие каталоги не помещаются в карантин
автоматически.

Полный backup v2 — весь `CONFIG_DIR`, а не только `config.json`. Внешние Project
и `~/.agents` в него не входят, не изменяются при переходе и требуют отдельного
backup. Общий Gateway-файл `~/.nessy/dp_auth_creds.json` тоже внешний.

## Редактирование файла

Для обычных изменений предпочитайте Settings:

| Setting        | Where to change it                          |
| -------------- | ------------------------------------------- |
| LLM connection | Settings → AI                               |
| Model          | Model picker in the chat input or status UI |
| Workspace      | Workspace dropdown in the sidebar           |

::: warning
Перед ручным редактированием `config.json` закройте Nessy Desktop и сохраните
backup. Invalid JSON не даст app запуститься. Никогда не кладите secrets в этот
файл — используйте [credential store](credentials).
:::
