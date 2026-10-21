# Плагины

Плагины объединяют связанные capabilities — skills, MCP server descriptors,
hooks, settings, commands и assets — в один устанавливаемый пакет. Пакет один
раз помещается в неизменяемый content-addressed cache Nessy и активируется
policy для global, Workspace, Project или session context. Nessy не копирует
плагин в каждую Workspace или Project.

Plugin runtime работает additively. Установка не переписывает
`CONFIG_DIR/workspaces/<workspaceId>/sources`, Workspace skills или automations,
project `.mcp.json`, project `.agents/skills` и project hook files.

## Что может дать plugin

| Capability | Как Nessy использует её |
| --- | --- |
| Skills | Exposed как read-only plugin-origin skills из installed bundle. Однострочная `!` context-команда выполняется только после qualification и permission admission через supervised Pi process path с pinned cwd, timeout и output limits. |
| MCP servers | Projected в runtime MCP pool как plugin capabilities, а не native source slugs. Remote и stdio серверы перечислены в панели MCP servers с per-server переключателем; сервер с OAuth или bearer token держит один глобальный credential на сервер, общий для всех workspaces. |
| Command hooks | Работают в workspace process-isolation profile и требуют explicit trust перед каждым запуском. |
| Prompt hooks | Добавляют одноразовую bounded hidden instruction, не запуская process и не выдавая execution authority. |
| Agent / mcp_tool / http hooks | Выполняются только через Pi host runners. Agent hook использует governed child-session port, MCP hook — matching session lease, а HTTP hook — credentialless permission-checked request через существующий webhook executor. |
| Prompt/slash commands | Markdown-команды доступны как namespaced prompt templates; они не исполняются как shell commands. |
| Agents | Markdown-agents доступны как plugin-origin agent definitions. |
| Language servers (LSP) | Plugin-contained executable или verified host-managed runtime запускается через `LspService` и `ProcessSupervisor` только для declared languages. Произвольный PATH lookup отключён. |
| Settings | Declared primitive settings проходят schema check и хранятся только в plugin-owned data namespace; они не merge в global Nessy preferences и удаляются при uninstall. MCPB `user_config` остаётся отдельным encrypted server configuration path. |
| Monitors и MCP channels | Trusted monitor с explicit cron schedule проецируется в существующий scheduler. До агента он доходит только пока идёт ход: tick, сработавший, когда session простаивает, пропускается, а не ставится в очередь, и `/tasks` перечисляет каждый такой monitor с этой пометкой. Bounded events `notifications/claude/channel` получает только session с matching live server lease, обёрнутыми в тег `<channel source="...">`. |
| Commands, assets | Хранятся в normalized bundle и проецируются как namespaced Nessy extensions. |

Все поддерживаемые форматы нормализуются в один manifest Nessy; происхождение
пакета не меняет runtime-поведение.

| Формат | Manifest / discovery | Поддержка |
| --- | --- | --- |
| Nessy | `plugin.json`, legacy `nessy-extension.json`, standalone `SKILL.md` | Нативный формат; legacy manifests нормализуются консервативно. |
| Codex | `.codex-plugin/plugin.json` | Skills, MCP, hook descriptors, LSP, typed settings, scheduled monitors и apps/connectors переводятся в governed capabilities Nessy. Connector с пригодным MCP transport становится MCP-backed Source; app-only connector ID остаётся явно неподдерживаемым. |
| Claude Code | `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` | Skills, MCP, hooks, команды, agents, contained LSP, typed settings, scheduled monitors и leased MCP channels переводятся в governed capabilities Nessy. |
| Claude Desktop extension | `.mcpb` / `.dxt` ZIP с корневым `manifest.json` | Node, Python и native MCP entrypoints работают через тот же runtime. Path traversal, symlinks, duplicate entries, oversized payloads и undeclared executables отклоняются до install. |

## Аутентификация MCP

Механизм определяется нормализованным runtime descriptor, а не именем в
Marketplace, названием plugin или catalog-полем `policy.authentication`:

| Требование | Поведение runtime |
| --- | --- |
| DP | Точная команда `dp ai mcp ...` gated общим Desktop-owned Spirit SSO broker. Один login действует для всех таких серверов; subprocess не может войти самостоятельно. |
| OAuth | Remote plugin server с OAuth владеет **глобальным credential-слотом** в `CONFIG_DIR/credentials.enc`, ключ — plugin и server name. Один вход действует во всех workspaces — никакого дублирования по workspace. |
| Bearer / environment | Объявленный bearer token запрашивается один раз и хранится в том же глобальном слоте плагина; environment binding запрашивается как configuration. OAuth-карточка не показывается. |
| None | Remote plugin server без auth declaration подключается без карточки и credential. |
| Unsupported app | Codex app ID без bundled materializable MCP transport завершает install/activation с diagnostic неподдерживаемого host connector. Nessy не угадывает endpoint. |

DP credentials остаются у Spirit CLI в `DP_WORKDIR` и не попадают в Nessy
credential vault. Failed-карточка generic OAuth терминальна и не содержит
действия Retry; новую попытку создаёт отдельный pending request. После failed
DP attempt соответствующий server-only replay остаётся retryable до cancel или
cleanup. Подробнее: [MCP authentication](../sources/mcp-servers/authentication).

Сервер с пустым credential-слотом не пропадает молча: он перечислен в
setup-чеклисте после установки, снова появляется в notice при старте сессии и
показывает бейдж needs-auth в панели MCP servers, пока вы не войдёте. Вход с
любой из этих поверхностей никогда не прерывает идущий turn.

## Отложенные компоненты

Ничего не отбрасывается молча. Command, prompt, agent, `mcp_tool` и
credentialless HTTP hooks работают через существующие host authorities.
Contained LSP, typed plugin settings, monitors с explicit schedule и leased MCP
channels активны; disable или uninstall останавливает их процессы и leases до
release. MCPB `user_config` работает через отдельный encrypted MCP configuration
path. Codex connectors с materializable MCP transport тоже работают: connector
нормализуется в plugin-owned MCP server на том же capability path, что и
остальные серверы плагина — Source не создаётся — и аутентифицируется через
глобальный credential-слот плагина (`ON_INSTALL` / `ON_FIRST_USE` — только
timing входа, не trust grant; отказ не имеет side effects). App-only connector
IDs явно помечаются как unsupported и не считаются transport. Deferred остаются output styles, themes, Claude
app-level settings и monitors без explicit schedule; пакет только из
deferred-компонентов не активируется автоматически.

Объявление, которое было *отклонено*, а не отложено — bundled MCP server,
уступивший как дубликат, или сервер, чью команду runtime не принял, — показано
вместе с причиной в разделе **Diagnostics** на странице самого плагина, рядом с
компонентами, которые загрузились. Плагин, у которого не осталось ни одного
пригодного компонента, говорит об этом в своём состоянии, а не выглядит
активным. Плагин, установленный более ранней версией, несёт те записи, с
которыми был установлен, пока его не обновят или не отремонтируют
(Plugins → меню плагина → Repair).

## Marketplace и жизненный цикл

Marketplace — это канал поставки: отдельные вкладки **Plugins** и **Skills**
над одним server-side поиском, плоские строки результатов с format/acquisition
badges, полоса «Installed» сверху и detail-вид, который показывает описание,
information и — после установки — полный состав пакета (skills, commands,
hooks, connectors, MCP servers) с переходом на страницу каждого компонента.
Compatibility state и actionable diagnostics показываются per item; пакет,
вернувшийся partial, ждёт вашего явного подтверждения, прежде чем
активироваться, а заблокированный пакет отклоняется с показанной причиной.

Управление живёт в **Sources**, а не в Marketplace: подраздел **Plugins** под
Sources перечисляет установленные плагины, а enable/disable/update/repair/
uninstall выполняются оттуда (установка из Marketplace передаёт вас на эту
страницу). Enable/disable применяется per workspace или per active project и
обновляет live sessions.

Установка больше не заканчивается тишиной. Результат установки перечисляет
каждое незакрытое требование, и сразу после установки рендерится
**setup-чеклист**: вход в Developer Platform — один клик (один login
разблокирует сразу все DP-серверы), плагин с объявленной user configuration
открывает свой prompt настройки из чеклиста, а OAuth-серверы перечислены с
указателем на notice при старте сессии — OAuth-флоу в установку не встраивается.
Чеклист ничего не блокирует: пропустите его, и каждый пункт останется доступен
позже из notice сессии и со страницы плагина.

Когда сессия стартует в workspace, где серверы ещё ждут входа, ненавязчивый
**notice** перечисляет их — DP, OAuth и bearer одинаково, плюс серверы, чьё
подключение при старте не удалось. Вход из notice выполняется, не прерывая
разговор. Включённые серверы по умолчанию подключаются при старте сессии;
`sources.connectOnStartup: false` в `config.json` (или managed-ключ
`connectSourcesOnStartup`) возвращает подключение по первому обращению.

Если extension объявляет user configuration, его страница показывает статус
**Требуется настройка**. Все объявленные значения хранятся вместе в одной
scoped encrypted plugin-configuration record; metadata secret-полей
по-прежнему управляет redaction и editing behavior. Configure, clear, enable,
disable и uninstall инвалидируют один и тот же runtime snapshot.
Встроенный в plugin MCP server не требует создавать дублирующий Source —
серверы плагина принадлежат плагину и никогда не появляются в списке sources.

У отдельных возможностей плагина — MCP-серверов, skills, hooks и команд — свои
переключатели: один MCP-сервер из десяти можно выключить,
не теряя остальные девять. Панель **MCP servers** перечисляет все серверы —
plugin-owned и созданные пользователем вместе — с origin, transport и auth
state каждой строки и per-server переключателем на строках плагина; страница
плагина показывает те же строки, отфильтрованные до этого плагина.
Выключенная возможность сразу уходит из live-сессий
(shared MCP pool останавливает её сервер, если он не нужен другому чату),
строка отображается приглушённой с пометкой «Отключено», а повторное включение
возвращает её немедленно. Отключение плагина целиком остаётся терминальным:
per-capability переключатели никогда не воскрешают подавленный плагин.

Тот же жизненный цикл ассистент может вести и сам — через отдельные session
tools (plan, install, status, manage). Эти инструменты никогда не запускают
shell-команду, никогда не раскрывают credentials и никогда не выдают
executable trust за вас.

### Свой registry

Кроме установки отдельных плагинов, можно добавить целый **registry** — Git
репозиторий, Git URL или локальную папку с catalog-манифестом
(`marketplace.json` / `plugins.json`), перечисляющим много плагинов. Добавьте
через **Marketplace → Create → Add marketplace** (source, опциональный Git ref,
опциональные sparse paths); его записи появляются отдельной секцией рядом со
встроенным market. Upgrade перекачивает Git-registry, Remove удаляет (с
подтверждением), встроенный market удалить нельзя. После добавления открывается
его секция, и там сказано, если catalog ещё загружается или не загрузился.
Registry, чей catalog не загрузился, отмечается inline, не скрывая остальное, а
пока вы смотрите любую другую секцию, заметка сообщает: «Некоторые marketplace
не удалось загрузить». Catalog забирается на
сервере тем же governed staging path, что и install плагина — интерфейс не
фетчит контент плагинов напрямую, а расположение registry на диске не попадает
в UI.

### Создание навыков и плагинов

Nessy поставляет два встроенных guide-скилла — **Skill Creator** и **Plugin
Creator** — которые seed'ятся в `~/.nessy-agent/skills/` при первом запуске
(только когда отсутствуют; отредактированный вами скилл не перезаписывается).
Команды **/create-skill** и **/create-plugin** в композере (или **Marketplace →
Create → Create plugin**) открывают видимый чат, который интервьюирует вас и
scaffold'ит скилл/плагин по схеме и путям Nessy, затем валидирует через
существующий `skill_validate` / plugin-install path. Это guided prompt-флоу — без
нового tool и без elevated access; файлы пишутся обычным permission-gated путём.

Executable trust выдаёте вы. Command hooks и stdio MCP servers, которым нужен
review, перечислены в trust-панели, где вы выдаёте или отзываете конкретную
возможность. Установка или включение плагина никогда не выдаёт trust
автоматически, а обновление или изменившийся bundle возвращает состояние
review-required.

## Marketplace safety

Marketplace entries сначала metadata. Nessy устанавливает supported `npm`, marketplace file-snapshot, GitLab skill, URL archive и repository sources через structured install descriptors, но поля marketplace `install.command` и Codex plugin install commands — только display metadata. Install service никогда их не выполняет. Multi-file skills устанавливаются из per-file snapshot маркетплейса, каждый файл проверяется по опубликованной контрольной сумме.

Repository URL installs работают через proposal flow. Агент или UI могут предложить typed source из repository URL на поддерживаемом host, но successful installation всё равно идёт через backend fetch, staging, normalization, validation и `PluginStore` commit. Unsupported URLs или unsafe archives возвращают diagnostics instead of writing plugin, skill, source, hook, trust или lock files.

**У каких hosts есть route.** Nessy никогда не клонирует — он забирает archive,
поэтому единственный вопрос, на который отвечает hostname: *в какой форме
archive мы с ним говорим*:

| Host | Заметки |
| --- | --- |
| `github.com` | Route `archive/<ref>.tar.gz` |
| `gitlab.com` и любой DNS label `gitlab` (`gitlab.example.com`) | Документированный GitLab v4 archive route |
| `git.tcsbank.ru` | Собственный git host этого форка, известен по имени, на том же GitLab v4 route |
| Прочий self-hosted GitLab | Объявите его в `NESSY_PLUGIN_GITLAB_HOSTS` — см. [environment variables](../reference/config/environment-variables) |
| `bitbucket.org` | Route `get/<ref>.tar.gz`; default branch и tag listing читаются из собственных форм payload Bitbucket |
| `dev.azure.com` | Azure DevOps Services. Его items route отдаёт только **zip**, поэтому pipeline обрабатывает и этот формат наряду с tar |

Проверка GitLab — это **DNS label**, а не подстрока: `gitlab.example.com`
резолвится, `notgitlab.io` и `gitlab-mirror.example.net` — нет, а host, который
похож на GitLab, не будучи им, получает refusal, называющий environment
variable, вместо вида «сломалось». Azure DevOps **Server** (on-premises),
legacy-написание `<org>.visualstudio.com` и GitHub Enterprise Server оставлены
за пределами набора намеренно — каждый адресует repository иначе, а объявленный
GHES host резолвил бы свои tags против `github.com`. AWS CodeCommit вообще не
публикует archive route, поэтому он структурно недостижим, а не просто не
реализован.

Local bundle installs сначала copy files в staging directory, reject unsafe symlinks, validate paths, normalize metadata и только потом commit into Nessy-owned plugin cache.

## Владение данными

Пакет плагина, policy, trust, data и credentials хранятся отдельно:

| Назначение | Расположение |
| --- | --- |
| Реестр установленных пакетов | `CONFIG_DIR/plugins/installed.json` и lock/journal state |
| Неизменяемый bundle | `CONFIG_DIR/plugins/cache/<encoded-marketplaceId>/<encoded-pluginId>/<encoded-version>/<bundleHash>` |
| Global activation policy | `CONFIG_DIR/capabilities.json` |
| Workspace activation policy | `CONFIG_DIR/workspaces/<workspaceId>/capabilities.json` |
| Project и executable trust | `CONFIG_DIR/project-trust.json` и `CONFIG_DIR/capability-trust.json` |
| Scoped writable data | `CONFIG_DIR/plugins/data/<encoded-plugin-key>/workspaces/<workspaceId>[/projects/<projectKey>]` |
| OAuth, bearer и plugin-configuration secrets | Записи в `CONFIG_DIR/credentials.enc`; OAuth/bearer-слот plugin MCP server глобальный, ключ — plugin и server name |
| DP SSO credentials | Состояние Spirit CLI в `DP_WORKDIR` (никогда не копируется в plugin или credential storage Nessy) |

Сегменты marketplace, plugin и version — это обратимое base64url-кодирование, а не сырые внешние идентификаторы.

Bundle hash охватывает нормализованное дерево: contents, paths, types,
executable bits и symlinks, а не только manifest. Установленные bundles доступны
только для чтения. Writable data не зависят от версии и разделены так, чтобы
Workspace или Project не передавали состояние друг другу. `installed.json`
отвечает только на вопрос, какой экземпляр пакета установлен; activation, trust,
credentials и writable data ему не принадлежат. Lifecycle status вычисляется из
operation journal, integrity checks и текущего marketplace listing, а не
хранится как package enablement.

## Visibility and trust

Plugin enablement scoped:

| Scope | Meaning |
| --- | --- |
| `global` | Доступен во всех Workspace данного пользователя. |
| `workspace` | Доступен в одном Workspace Nessy. |
| `project` | Доступен для одного Project, включая overlays из `.nessy-agent/config.toml`. |

После bundle/native defaults policy применяются по слоям global, Workspace,
policy доверенного active repository, private override по
`(workspaceId, ProjectKey)`, затем session selection. Repository policy не
читается до whole-project trust; private override принадлежит Nessy и никогда
не записывается в repository. Совпавшее `enabled: false` терминально: более
узкий scope не может снова включить plugin. В остальных случаях
capability-level значения более узкого scope могут переопределять более широкие
без изменения всего plugin.

Marketplace skills устанавливаются как skill-only plugins. По умолчанию они enable в текущем workspace, если он доступен; пользователь может явно enable skill для текущего project из actions установленного item. Native project, workspace и global skills сохраняют обычный precedence над plugin-provided skills с тем же slug.

Ключ trust состоит из plugin instance, capability ID, executable hash и scope.
Изменение command или executable context сбрасывает trust decision, поэтому
command hooks не могут незаметно сменить исполняемое действие.

Skills и agents с одинаковыми именами остаются доступны по qualified IDs; для
non-MCP compatibility names побеждает ближайший scope, затем native capability
перед plugin capability. MCP server плагина никогда не получает короткое wire
name — он всегда несёт wire name `plugin_<pluginId>_<serverName>`, делит он
logical name с другим сервером или нет, — тогда как built-in или сервер,
настроенный вами, сохраняет своё короткое имя независимо от того, какие
плагины установлены. Когда сервер плагина дублирует уже запущенный — ту же
built-in command или тот же declared endpoint, что и у сервера другого
плагина, — дубликат отступает и остаётся видимым с указанием причины вместо
повторного запуска, и эта причина называет также собственные hooks и skills
плагина, которые ссылались на отступивший сервер и потому не работают. Полное
правило — на странице
[MCP servers](../sources/mcp-servers/overview).

Для каждого turn server один раз объединяет policy, Project trust, exact-hash
executable trust, credential readiness и session selection в неизменяемый
revision-pinned snapshot. Pi runtime, Composer metadata и user catalogs —
безопасные представления одного snapshot; они не сканируют файлы повторно и не
применяют разные precedence rules во время turn.

## Hooks

Global native hooks живут в `CONFIG_DIR/hooks.json`. Workspace hooks живут
в hook files или config Workspace, project hooks — в `.nessy-agent`, а plugin hooks
приходят из installed plugin projection. Runtime ordering:

1. internal permission and pre-tool checks
2. native global and workspace hooks
3. project `.nessy-agent` hooks
4. trusted plugin hooks

Plugin hooks не wired через marketplace commands. Command, prompt, agent,
mcp_tool и credentialless HTTP actions выполняются только после pinned
capability/trust revalidation и effective Pi permission decision. Raw auth
material в HTTP descriptor fail-closes до policy и network access.

## Existing workflows stay separate

- Создавайте и authenticating API, MCP и local-file sources через **Sources**.
- Author editable skills в global, workspace или project skill folders.
- Управляйте app-event automations через `automations.json`.
- Используйте `.nessy-agent` project files для project overlays и project hooks.

Plugins can add capabilities to those runtime views, но они не становятся owner of those existing files.

## Каталог навыков по ролям

В локальной сборке Odysseus раздел «Источники → Навыки» открывает каталог с четырьмя вкладками:
«Общие», «QA», «DEV» и «SA» (системные аналитики). Один навык может подходить нескольким ролям.
247 уникальных навыков имеют русские описания. Поиск проверяет название и описание
в выбранной вкладке. Кнопка «Подробнее» показывает, когда и как применять навык,
а также необходимые подключения.

«Применить» создаёт чат с подготовленным запросом. Проверьте его и добавьте задачу
перед отправкой. Для общего навыка запрос содержит путь к его инструкции; для
активного навыка агента используется его точное имя вызова.

Кнопка «Управление плагинами» и раздел «Плагины» открывают интерфейс установки и настройки. Каталог навыков доступен отдельно через «Источники → Навыки».

Локальная сборка теперь называется **Odysseus**. Тема «Odysseus» доступна в настройках оформления; смена бренда сохраняет пути профиля и подключённые сервисы.

## Как понять, какой навык выбрать

Карточки описывают действие простыми словами. У навыков с отметкой «Автовыбор»
есть блок «Когда агент может выбрать сам»: он называет подходящую задачу.
В «Подробнее» показаны пример запроса, необходимые подключения и способ применения.

Агент учитывает смысл запроса и контекст текущей работы. Это не поиск одного слова
и не расписание: совпадение темы не гарантирует запуск, навык должен быть доступен
агенту. Например, browser подходит для действий на странице, а docx — для работы
с Word. Действия во внешних сервисах остаются в границах вашего поручения.

«По запросу» означает явный выбор навыка или прямое поручение его специальной задачи.
У дополнительных навыков с отметкой «Правила агента» способ выбора определяется
самим агентом и инструкцией навыка. «Применить» подготавливает черновик чата;
отправку сообщения выполняет пользователь.

Рекламные и маркетинговые навыки исключены из общего набора: кампании, SEO, рассылки, продажи и проморолики. Общие инструменты для документов, графики и видео сохранены.
