# Рабочая папка

Рабочая папка — это **current working directory (cwd)** агента, то же понятие `cwd`, что и в terminal. Если вы не скажете иначе, file operations и shell commands разрешаются относительно этой папки. Попросите посмотреть config file или запустить test suite — агент начнёт именно оттуда.

Изменить её можно в любой момент диалога.

## Что делает working directory

Представьте, что вы открыли shell и выполнили `cd /path/to/project`. С этого места каждое действие агента привязано к выбранной папке:

- **Read** files и их содержимое
- **Write** новые files или overwrite existing ones
- **Edit** files через точные text replacements
- **Search** через Glob (file patterns) и Grep (content search)
- **Run** bash commands в этой directory

Это отличается от [Sources](../sources/overview), которые обращаются к внешним services через MCP. Working directory покрывает прямой доступ к files на вашей машине.

## Установка working directory

Нажмите folder badge в chat input, чтобы установить или изменить cwd для текущего диалога. Badge показывает folder name и, если directory — git repository, current branch.

По нажатию можно:

- Выбрать из recent directories
- Browse другую folder
- Reset к starting directory этой session

Изменение применяется сразу — последующие commands выполняются из нового location. Nessy Desktop хранит short history recent directories, чтобы вернуться назад одним click.

Когда cwd — git repository, рядом с badge есть контрол ветки: перечисляет
локальные ветки и переключает между ними. При незакоммиченных изменениях он не
падает молча — объясняет, что есть local changes, и предлагает «Stash & switch»,
который стэшит вашу работу, переключается и восстанавливает её (изменения никогда
не теряются, даже если восстановление конфликтует). Вне git-репозитория контрол
показан disabled с кратким пояснением.

## Доступные tools

Эти agent-native tools по умолчанию работают из cwd:

| Tool | Purpose | Example |
| ---- | ------- | ------- |
| **Read** | Просмотр file contents | Read a configuration file |
| **Write** | Создание или overwrite files | Write a new component |
| **Edit** | Точные text replacements | Fix a bug in existing code |
| **Glob** | Поиск files by pattern | Find every `*.tsx` file |
| **Grep** | Поиск по file contents | Find usages of a function |
| **Bash** | Запуск shell commands | Run tests or git operations |

Каждый из них обращается к filesystem напрямую, без MCP layer между ними.

## Project Context And Memory Files

Если working directory содержит `CLAUDE.md` или `AGENTS.md`, их содержимое передаётся агенту как project context. Match case-insensitive, поэтому `Claude.md`, `agents.md` и похожие casings тоже работают. Files обнаруживаются рекурсивно по directory tree, что поддерживает monorepos, где каждый package имеет свой context file. Каждый file ограничен 10&nbsp;KB; всё сверх этого truncate.

Используйте эти files, чтобы записать:

- Project structure and conventions
- Build and test commands
- Какие files важны и что они делают
- Team-specific guidelines

```markdown
# CLAUDE.md

This is a Next.js application written in TypeScript.

## Commands
- `npm run dev`   — start the development server
- `npm test`      — run tests
- `npm run build` — production build

## Structure
- `src/components/` — React components
- `src/lib/`        — utility functions
- `src/app/`        — Next.js app-router pages
```

Агент читает это автоматически, когда диалог выполняется в этой working directory.

Durable memory хранится в `MEMORY.md`. Project `MEMORY.md` объединяется с
personal и session memory перед каждым turn, а memory files могут inline nearby
markdown через `@import ./path.md` или `@./path.md`.

Меню **Memory** самого чата говорит, что при этом делает рантайм. В разделе
**Runtime notes** сессия Claude Code теперь сообщает, ведёт ли рантайм
собственные заметки для этого чата и в какой каталог он их пишет — они переживают
чат, и ничто в Nessy их не читает, — либо что память для этого чата выключена и
не происходит ни того, ни другого. Тот же раздел говорит, когда администратор
перевёл сессию в restricted mode рантайма, что файлы, покрытые вашими
deny-правилами, убирает из результатов поиска само приложение Nessy, а не
рантайм, и что рантайм может сам войти в git worktree, а записанная здесь working
directory при этом останется прежней.

Для path-specific guidance добавьте markdown files в `.agents/rules/` с
frontmatter path match:

```markdown
---
paths:
  - packages/ui/**
---

Prefer existing UI primitives before adding a new component.
```

Rule загружается только когда current working directory matches declared path,
поэтому monorepo может держать package-specific instructions без утечки в
unrelated tasks.

## Установка cwd из CLI

Для one-shot runs передайте directory команде `run` через `--workspace-dir`:

```bash
bun run apps/cli/src/index.ts run --workspace-dir /path/to/project "Summarise the repo"
```

CLI создаёт или переиспользует name-only Workspace, валидирует directory как
внешний Project и выбирает его через непрозрачный Workspace-bound handle, затем
отправляет prompt. Directory не становится хранилищем Workspace. См.
[CLI reference](../reference/cli) для полного набора flags.

## Working Directory vs Sources

| Aspect | Working Directory | Sources |
| ------ | ----------------- | ------- |
| **Access method** | Direct agent tools (`Read`, `Write`, `Bash`) | MCP tools (`mcp__slug__toolname`) |
| **Scope** | Одна локальная folder | Один или несколько services или paths |
| **Authentication** | Не требуется | OAuth, API keys или tokens |
| **Permission control** | Session permission modes | Per-source `permissions.json` |
| **Project context** | `CLAUDE.md`, `AGENTS.md`, memory и rules | Source guide instructions |
| **Typical use** | Coding и local files | External services и remote data |

## Когда использовать

**Используйте working directory для:**

- Написания и редактирования code
- Запуска build scripts и tests
- Git operations (commit, branch, diff)
- Чтения project files и configs
- Всего, что касается local files

**Используйте sources для:**

- Доступа к external services через MCP
- Чтения из remote APIs
- Подключения к hosted databases
- Доступа к files elsewhere через MCP filesystem server
- Всего, чему нужна authentication к external service

**Используйте вместе.** Многие workflows объединяют их: получить issues из MCP source, затем исправить в code; прочитать documentation из API source, затем написать implementation locally.

## Best Practices

- **Держите context files актуальными.** Хорошо поддерживаемые `CLAUDE.md`, `AGENTS.md` и `MEMORY.md` помогают агенту понять structure и conventions проекта. Обновляйте их вместе с project.
- **Указывайте конкретный project.** Вместо home folder задавайте cwd ровно на project, с которым работаете — агент будет focused и быстрее.
- **Опирайтесь на git integration.** Когда cwd — git repository, badge показывает branch, а агент может эффективно использовать git. Используйте Plan mode, чтобы безопасно review changes перед commit.
- **Добавляйте extra folders как sources.** Работаете в нескольких locations? Оставьте primary project как working directory и зарегистрируйте каждый additional path как [local folder](../sources/local-filesystems).

## Область проекта и пространство `.nessy-agent`

Workspace объединяет проекты, возможности и сессии; выбранный проект — это
фактическое файловое рабочее пространство агента. Канонический путь проекта —
единственный основной файловый корень сессии: файловые инструменты и shell
работают внутри него без дополнительных подтверждений. Файловые инструменты Pi
могут без запроса писать и в системные временные папки (`$TMPDIR`, `/tmp`), а
shell-команда, которая пишет туда, на Claude Code и Pi спрашивает: в режиме
Manual, а перенаправление туда (например, `echo x > /tmp/a`) — и в Accept edits.
Управляемое
хранилище Nessy в `~/.nessy-agent` остаётся недоступным обычным файловым
инструментам, даже если одобрена более широкая родительская папка. Метаданные
git (`.git`) и агентская конфигурация проекта (`.nessy-agent`, `.agents`)
доступны файловым инструментам агента только на чтение — правьте их сами.

У каждого чата есть и своя временная папка для черновых файлов:
`~/.nessy-agent/sessions/<workspace>/<session>/job/tmp` (внутри вашей папки
данных, если вы её перенесли). На Claude Code и Pi вызовы `Write` и `Edit`
агента в неё проходят без карточки подтверждения в режимах Manual, Accept edits
и Auto; Plan по-прежнему отказывает в записи, а Don't ask её
запрещает. Исключение касается только `job/tmp` этого чата: остальная папка
`job` и временная папка другого чата спрашивают как обычно. Из shell без
карточки туда пишет только Claude Code — команда только для чтения, например
`echo`, с перенаправлением в `$CLAUDE_JOB_DIR/tmp/…`; буквальный путь к папке и
любое написание на Pi спрашивают как обычно. Папка удаляется вместе с чатом.
Codex получает родительскую папку `job` в переменной окружения
`NESSY_SESSION_JOB_DIR`.

Контрол **Primary folder** на странице Permissions этот корень не двигает. Он
выбирает, какая из уже подключённых папок показывается и сортируется первой, —
см. [Permissions](permissions#основная-подключенная-папка).

Путь вне корня проекта вызывает одно структурированное подтверждение с
каноническим путём и требуемым доступом. «Разрешить один раз» действует только
для этого вызова; «Разрешить для сессии» добавляет отзываемый корень сессии,
видимый в панели runtime. Одобрения не переносятся в другие сессии и ветки.

Доверенный проект может настраивать Nessy через `<project>/.nessy-agent/`:
`config.toml` (`[defaults] model / thinking_level / permission_mode` — проект
может сузить, но не ослабить ваш уровень разрешений — и селекторы
`[plugins]`), а также `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`,
`hooks.json` и `MEMORY.md`. Ничего из репозитория не загружается до выдачи
доверия проекту, а устаревший каталог `.nessy` полностью игнорируется.

То же решение действует и на рантаймах Claude Code и Codex. В **Claude Code**
проект, которому вы не доверили («Оставить ограниченным» или пока без ответа),
ничего не привносит из репозитория: его `.claude/settings.json` и
`.claude/settings.local.json` (их hooks, блок `env` и правила разрешений),
серверы из его `.mcp.json`, его `CLAUDE.md` и `CLAUDE.local.md`, а также rules,
skills, commands и subagents из его `.claude/` не загружаются. Ваши собственные
пользовательские настройки Claude Code по-прежнему загружаются. В **Codex**
Nessy записывает ваше решение в конфигурацию Codex как запись доверия для этой
папки, поэтому Codex никогда не начинает доверять папке сам при открытии
session: слой `.codex/` ограниченного проекта (его MCP-серверы, hooks и rules)
не загружается, и `AGENTS.md` проекта Codex сам тоже не читает. Skills ограниченного
проекта Codex всё равно загрузил бы — из его папки `.codex/skills` и из каждой папки
`.agents/skills` между корнем проекта и рабочей папкой, — поэтому каждый раз, когда
чат открывает поток Codex, Nessy запрашивает у Codex этот список и отключает каждый
такой skill; если Codex не может отдать список, поток не открывается. Skill,
добавленный в проект, пока чат уже открыт, остаётся доступен до следующего открытия
потока в этом чате. Доверие проекту
возвращает всё это. Что бы вы ни решили, `.codex/config.toml` проекта — или ваш
собственный `~/.codex`, когда проектом служит домашняя папка, — не может
отключить sandbox или approval policy Codex и не может отдать ваши подтверждения
проверяющему Codex, пока [Codex auto-review](../reference/config/config-file)
выключен: Nessy заново задаёт всё это вместе со своим permission profile в каждом
открываемом thread, поверх любых настроек проекта.

Перед решением диалог доверия показывает, что репозиторий на самом деле
привносит: файлы инструкций `AGENTS.md`/`CLAUDE.md`, конфигурацию
`.nessy-agent`, конфиги MCP-серверов, skills и hooks. Обнаружение read-only —
ничего не исполняется, слишком большие и нерегулярные файлы пропускаются, в
диалог попадают только имена без путей. Тот же состав можно пересмотреть позже
из панели Sources.

С 1.40.0 запрос вообще не появляется там, где этот состав пуст: папка, которая
ничего не привносит, не стоит вопроса, — и запрос возвращается в тот момент,
когда что-то появляется (он пересчитывается на каждую сессию и на каждый запуск,
а само состояние недоверия не меняется). Состав, который читает запрос, теперь
покрывает весь уровень `.nessy-agent`, который он показывает (`agents`,
`mcp.json`, `hooks.json`, `permissions.json`, `MEMORY.md`, `rules`), и
переносимый слой `.agents/skills` — раньше не покрывал. С 1.41.0 в него входят и
слои, которые Claude Code и Codex загружают только для доверенного проекта:
`config.toml`, `hooks.json`, `rules/` и `agents/` папки `.codex/`, а также
`.claude/skills` и `.claude/rules`, — поэтому о папке, где есть только один из них,
тоже спрашивают. Для папки внутри репозитория в него входят и те слои, которые
среды читают выше папки, — в корне репозитория и во всех папках между ними,
например корневые `.codex/`, `.claude/skills`, `.mcp.json` или `AGENTS.md`
монорепозитория; они перечислены по пути относительно папки (например,
`../../.claude/skills`).
В связанном git worktree в него входит и то, что Claude Code читает из основной
копии репозитория: её `.claude/settings.local.json`, а также `.claude/agents` и
`.claude/commands`, если в worktree нет своей папки с таким именем (например,
`../main/.claude/commands`). Доверие по-прежнему спрашивается для каждой папки:
доверие основной копии не распространяется на её worktree.
Claude Code читает и выше, и запрос следует за ним: `CLAUDE.md`, `CLAUDE.local.md`,
`.claude/CLAUDE.md`, `.claude/rules` и `.mcp.json` папок выше корня репозитория, а
для папки вне репозитория — ещё `.claude/skills`, `.claude/agents` и
`.claude/commands` её родительских папок; обход останавливается ниже домашней
папки, поэтому о вашей личной настройке `~/CLAUDE.md` и `~/.claude` не спрашивают
(в сессии Claude Code в Nessy она загружается только для доверенного проекта).
На Pi доверие ещё и запускает языковые серверы включённых плагинов анализа кода и
проверки после каждой правки, поэтому с 1.41.0 запрос называет и эти серверы, а об
обычной папке с кодом спрашивают, пока такой плагин включён.
