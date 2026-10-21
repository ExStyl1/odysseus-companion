# Skills

Skills — reusable instruction folders, которые учат агента повторяемой job. Каждый skill — directory с file `SKILL.md`: YAML frontmatter, описывающий skill, плюс markdown body, которому агент следует при запуске skill. Invoke skill через `@`-mention в composer, запускайте его как собственную slash command `/slug` или дайте агенту подобрать его автоматически, когда description подходит к task.

File layout совпадает с convention `SKILL.md`, используемой Claude Code и другими agent tooling, поэтому skill folder, написанная для одного tool, обычно работает и в других.

## Creating Skills

Самый быстрый путь — описать нужный skill и дать агенту написать его:

```
Create a skill called "commit" that writes conventional commit messages
```

Агент знает storage layout и frontmatter schema, поэтому может scaffold folder, fill metadata и iterate on instructions вместе с вами. Можно создать folder вручную — skill это просто files on disk.

Для guided-флоу используйте **/create-skill** в композере (или действие **Add Skill**). Откроется видимый чат под управлением встроенного guide-скилла **Skill Creator**, который интервьюирует вас, scaffold'ит валидный `SKILL.md` и валидирует его. Skill Creator и Plugin Creator поставляются с приложением и seed'ятся в ваши skills при первом запуске — только когда отсутствуют, поэтому отредактированный вами skill не перезаписывается.

## Skill Anatomy

Skill Workspace находится в управляемом каталоге ресурсов Workspace.
`CONFIG_DIR` равен `NESSY_CONFIG_DIR`, если переменная задана, иначе —
`~/.nessy-agent`:

```
CONFIG_DIR/workspaces/<workspace-id>/skills/<slug>/
├── SKILL.md      # Required — frontmatter + instructions
└── icon.png      # Optional — cached automatically when icon is a URL
```

Folder name — slug skill (lowercase alphanumeric with hyphens). Extra files — scripts, templates, reference material — могут лежать рядом с `SKILL.md` и referenced from instructions.

### SKILL.md Format

```markdown
---
name: Commit
description: Write conventional commit messages from the staged diff
icon: 🔧
allowed-tools:
  - Bash(git status)
  - Bash(git diff)
paths:
  - "**/.git/**"
requiredSources:
  - issue-tracker
---

When asked to commit:
- Use conventional prefixes (feat:, fix:, docs:, refactor:)
- Keep the subject line under 72 characters
- Explain the reason for the change, not the mechanics
```

Всё выше второго `---` — metadata; всё ниже — instruction body, передаваемый агенту при invocation.

### Frontmatter Fields

| Field | Required | Description |
| ----- | -------- | ----------- |
| `name` | No | Human-readable display name; по умолчанию — имя folder |
| `description` | Recommended | Short summary в skill picker; по нему агент решает relevance. Fallback — первый paragraph body |
| `when_to_use` | No | Дополнительный trigger context (фразы, примеры запросов), добавляется к description в listing |
| `icon` | No | Emoji (`🔧`) или icon URL. Relative paths и inline SVG rejected. |
| `arguments` | No | Именованные positional arguments для `$name` substitution — space-separated строка или YAML list; порядок и есть mapping позиций |
| `argument-hint` | No | Autocomplete hint ожидаемых аргументов, например `[issue-number]` |
| `allowed-tools` | No | Tools, pre-approved для invoking turn — они пропускают approval prompt. Ничего не ограничивает: остальные tools остаются доступными по вашим обычным permission rules |
| `disallowed-tools` | No | Tools, убираемые из pool, пока skill активен — именно это поле ограничивает |
| `disable-model-invocation` | No | `true` запрещает модели вызывать skill и убирает его из listing; вы всё ещё можете вызвать его сами. Default `false` |
| `user-invocable` | No | `false` прячет skill из `/` menu; модель всё ещё может его вызвать. Default `true` |
| `model` | No | Override модели, пока skill активен |
| `effort` | No | Override effort level: `low`, `medium`, `high`, `xhigh` или `max`; нераспознанное значение игнорируется |
| `paths` | No | Glob patterns, ограничивающие *автоматическую* activation файлами по match; ваш собственный вызов не gated. `globs` принимается как legacy alias |
| `alwaysAllow` | No | Tool patterns pre-approved while skill runs (например `["Bash(bun test)"]`) |
| `requiredSources` | No | Source slugs enabled automatically whenever skill runs |

Дефисные spellings выше следуют общей convention `SKILL.md`; camelCase spelling каждого поля (`allowedTools`, `userInvocable`, …) тоже принимается.

`allowed-tools` и `disallowed-tools` читаются так же, как [tool patterns](../go-further/workspaces#tool-patterns) агента: YAML-список или одна строка, элементы которой разделены пробелами или запятыми, причём запятая **внутри** скобок принадлежит своему элементу — `Agent(reviewer, planner)` это один элемент, а не два. Frontmatter целиком разбирается как YAML, поэтому список, записанный в строку (`paths: [src/**, docs/**]`), означает ровно то же, что и блочная форма.

Parsing намеренно lenient: отсутствующий `name` берётся из имени folder, отсутствующий `description` — из первого paragraph body, а malformed YAML загружает body с пустой metadata, не выбрасывая skill. Всё равно объявляйте оба поля — они управляют picker и automatic selection, а tool `skill_validate` отмечает их отсутствие.

::: info
`requiredSources` убирает проблему "agent discovers a missing tool one turn too late": при invocation skill каждый listed source enabled for session before first turn. Source, not configured in workspace or not yet authenticated, skipped and handled at runtime instead. См. [Sources](../sources/overview) для setup.
:::

::: tip
Когда `icon` — URL, file скачивается один раз и caches как `icon.<ext>` внутри skill folder. Также можно просто положить `icon.svg`, `icon.png` или `icon.jpg` в folder — auto-discovered without frontmatter.
:::

## Using Skills

Skill можно вызвать тремя способами:

- **Mention.** Введите `@` в message box и выберите skill из menu или продолжайте печатать, чтобы filter by slug:

  ```
  @commit
  @review the authentication changes
  @release-notes for the last sprint
  ```

- **Slash command.** Каждый skill также регистрируется как `/slug` (если frontmatter не ставит `user-invocable: false`); текст после команды становится аргументами skill.

- **Автоматически агентом.** Модель вызывает skill сама, когда description и `when_to_use` подходят к task — если не стоит `disable-model-invocation: true`, а при заданных `paths` — только во время работы с matching files.

Mention сохраняется в message как token `[skill:slug]`, а instructions skill передаются агенту на этот turn. Tools из `allowed-tools` или `alwaysAllow` skip approval prompt while skill active — всё остальное follows your normal [permission rules](../core-concepts/permissions). `allowed-tools` — это только pre-approval: он никогда не отбирает tool, и grant заканчивается вместе с turn-ом, в котором skill был invoked. Чтобы skill не дотянулся до какого-то tool, укажите его в `disallowed-tools` — это поле убирает tool из pool на этот turn.

### Arguments

Текст после вызова доступен внутри body skill через substitution tokens:

| Token | Разворачивается в |
| --- | --- |
| `$ARGUMENTS` | Вся строка аргументов как введена |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, … | Отдельные аргументы, 0-based |
| `$0`, `$1`, … | Короткая форма indexed-варианта |
| `$name` | Именованный аргумент из frontmatter-списка `arguments` |

Skill с `arguments: issue format` может написать `Fix issue $issue and output $format` и вызываться как `/fix-issue 123 markdown`.

## Skill Locations

| Scope | Path | Владение |
| --- | --- | --- |
| Nessy-managed global | `CONFIG_DIR/skills/<slug>/` | Состояние Nessy v2 |
| Shared personal | `~/.agents/skills/<slug>/` | Внешнее; Nessy его не переписывает |
| Workspace | `CONFIG_DIR/workspaces/<workspace-id>/skills/<slug>/` | Ресурс Workspace |
| Project | `<working-directory>/.agents/skills/<slug>/` | Внешний repository content |

После bundle/native defaults policy применяется в порядке global, Workspace,
policy доверенного active repository, private override по
`(workspaceId, ProjectKey)`, затем session selection. Terminal suppression
остаётся terminal. Private override принадлежит Nessy и никогда не записывается
в repository. Nessy ищет `.agents/skills`, начиная с активной [working
directory](../core-concepts/working-directory) и поднимаясь до корня Project.
Они загружаются только после повторной проверки идентичности backend и выдачи
whole-project trust. Внешние Project и `~/.agents` не изменяются при storage
cutover и не входят в backup `CONFIG_DIR`.

Skills с одинаковым slug не отбрасываются. Каждый доступен по qualified ID;
legacy unqualified mention использует детерминированный alias ближайшего scope с
приоритетом native и показывает collision diagnostic, а не зависит от порядка
файловой системы.

## Plugin-Provided Skills

[Plugins](../plugins/overview) также могут добавлять skills. Plugin skills
проецируются из неизменяемого content-hashed bundle как read-only runtime
capabilities, поэтому editable skill folders остаются в locations выше.

Если plugin skill использует тот же slug, что native Project, Workspace или
global skill, обе qualified capabilities остаются доступны, а unqualified alias
выбирает native skill в ближайшем scope. Управляйте плагином через plugin runtime
или страницу Plugins, не редактируя его cache.

## Validating Skills

После writing или editing skill попросите агента run tool `skill_validate` на slug. Он проверяет:

- slug valid lowercase-alphanumeric-with-hyphens name
- `SKILL.md` exists and readable
- frontmatter parses и содержит `name` и `description` (loader терпит их отсутствие, но validator хочет их объявленными)
- значения полей well-formed — например `effort` из допустимых levels
- неизвестные frontmatter keys дают warning, а не error, поэтому skill для более нового клиента всё равно загрузится
- body not empty
- icon, if present, is emoji, URL or supported image format

## Good Skill Design

- Начинайте `description` с *when* to use skill, не только what it does — этот text drives automatic selection.
- Держите instructions operational and testable: concrete steps, checks and output expectations лучше abstract advice.
- Кладите large examples в separate files inside skill folder, чтобы main guidance оставался readable.
- Предпочитайте несколько small single-purpose skills вместо одного sprawling; slugs are cheap.
