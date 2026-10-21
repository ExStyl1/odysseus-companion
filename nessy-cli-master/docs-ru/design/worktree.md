# Worktree — Дизайн универсальной возможности

## Постановка проблемы

В текущей версии nessy-cli реализована только внутренняя поддержка worktree для сценария сравнения нескольких моделей в Arena (`GitWorktreeService`). Пользователи не могут использовать изоляцию worktree в обычных сессиях, а AgentTool не поддерживает создание изолированной среды worktree для subagent.

Цель — сделать worktree универсальной возможностью, поддерживающей изоляцию на уровне пользовательской сессии и на уровне агента, сохраняя при этом полную совместимость с существующим функционалом Arena.

## Сравнение текущего состояния

| Функция                              | nessy-cli       | claude-code |
| ------------------------------------ | --------------- | ----------- |
| Инструмент `EnterWorktree`           | ❌              | ✅          |
| Инструмент `ExitWorktree`            | ❌              | ✅          |
| AgentTool `isolation: 'worktree'`    | ❌              | ✅          |
| Сохранение и восстановление состояния сессии worktree | ❌ | ✅ |
| Автоматическая очистка устаревших worktree | ❌        | ✅          |
| Post-creation setup (настройка hooks) | ❌             | ✅          |
| Отображение статуса worktree в StatusLine | ❌         | ✅          |
| WorktreeExitDialog (подтверждение выхода) | ❌         | ✅          |
| Символьные ссылки на директории (node_modules и т.д.) | ❌ | ✅ |
| sparse checkout                      | ❌              | ✅          |
| Флаг CLI `--worktree`                | ❌              | ✅          |
| Интеграция с tmux                    | ❌              | ✅          |
| Изоляция worktree для нескольких моделей Arena | ✅ (уникально для nessy) | ❌ |
| Перекрытие грязного состояния (stash + copy) | ✅       | ✅          |
| Отслеживание baseline commit         | ✅ (уникально для nessy) | ❌ |

## Принципы дизайна

**worktree — это универсальная возможность, Arena — это приложение поверх неё.**

- Универсальный слой worktree: инструменты `EnterWorktree`/`ExitWorktree`, параметр `isolation` AgentTool, управление состоянием сессии, автоматическая очистка
- Слой Arena: параллельное планирование нескольких моделей, настраиваемый путь `worktreeBaseDir`, массовое создание и сравнение diff, продолжение использования существующей логики `GitWorktreeService.setupWorktrees()` без изменений от универсального слоя

`isolation: 'worktree'` AgentTool использует только универсальный путь, Arena внутренне не создаёт worktree через этот параметр, пути независимы.

## Пути и конфигурация

### Универсальный путь worktree

worktree, созданные инструментом `EnterWorktree` или `isolation: 'worktree'` AgentTool, фиксируются в:

```
{корень git репозитория}/.nessy/worktrees/{slug}
```

Путь не настраивается. Правила именования slug:

- user session worktree: указывается пользователем или генерируется автоматически (формат: `{прилагательное}-{существительное}-{4 случайных символа}`)
- Agent worktree: `agent-{7 случайных hex символов}`

### Путь Arena worktree (существующий, без изменений)

Путь worktree Arena управляется через `agents.arena.worktreeBaseDir`, по умолчанию `~/.nessy/arena` (`ArenaManager.ts:125`), полностью независим от универсального пути, без изменений.

### Расширенная конфигурация (отложено до Phase C/D)

| Конфигурация                  | Тип        | Назначение                                                           | Этап    |
| ----------------------------- | ---------- | ---------------------------------------------------------------------- | ------- |
| `worktree.symlinkDirectories` | `string[]` | Символьные ссылки на указанные директории (например `node_modules`) в worktree для экономии места на диске | Phase C |
| `worktree.sparsePaths`        | `string[]` | git sparse-checkout cone mode, для больших monorepo только указанные пути | Phase D |

Phase A / B не добавляют новых конфигураций.

## Дизайн инструментов

### EnterWorktree

**Условие вызова:** Пользователь явно говорит "start a worktree", "use a worktree", "create a worktree" и т.п. Не следует вызывать автоматически, когда пользователь говорит "исправить баг", "разработать функцию".

**Входная schema:**

```
name?: string  // опционально, slug формат: буквы/цифры/точки/подчёркивания/дефисы, макс 64 символа
```

**Поведение:**

1. Проверить, что сейчас не в worktree (предотвращение вложенности)
2. Разрешить путь до корня git репозитория (обработка случая нахождения в поддиректории)
3. Вызвать `GitWorktreeService` для создания worktree, путь `.nessy/worktrees/{slug}`
4. Записать сессию worktree в `SessionService`
5. Переключить рабочую директорию на путь worktree
6. Очистить файловый кэш

**Выход:** `worktreePath`, `worktreeBranch`, `message`

### ExitWorktree

**Условие вызова:** Пользователь говорит "exit the worktree", "leave the worktree", "go back" и т.п.

**Входная schema:**

```
action: 'keep' | 'remove'
discard_changes?: boolean  // действует только при action='remove'
```

**Защитные механизмы:**

- Операции только с worktree, созданными этой сессией через `EnterWorktree`
- При `action='remove'` и наличии незакоммиченных изменений — отклонить (если только `discard_changes: true`)

**Поведение:**

- `keep`: очистить состояние worktree в сессии, сохранить директорию worktree и ветку, восстановить исходную рабочую директорию
- `remove`: удалить директорию worktree, удалить соответствующую git ветку, очистить состояние сессии, восстановить исходную рабочую директорию

**Выход:** `action`, `originalCwd`, `worktreePath`, `worktreeBranch`

## Способы активации пользователем

| Способ              | Пример                                                      | Этап реализации |
| ------------------- | ----------------------------------------------------------- | --------------- |
| Явный запрос в сессии | Пользователь говорит "начать работу в worktree" → модель вызывает EnterWorktree | Phase A  |
| Изоляция агента     | Модель устанавливает `isolation: 'worktree'` для subagent   | Phase B  |
| Флаг запуска CLI    | `nessy --worktree my-feature`                               | Phase D  |

Без slash команд. Активация worktree в сессии зависит от явного упоминания пользователем, `isolation: 'worktree'` — это сценарий автономного решения модели.

## Поэтапный план реализации

### Phase A: Базовые инструменты (user session worktree)

**Цель:** Пользователь может входить/выходить из worktree в сессии.

**Функции для реализации:**

- Инструмент `EnterWorktree`: создание worktree, переключение рабочей директории, запись состояния сессии
- Инструмент `ExitWorktree`: два способа выхода keep / remove, защитные механизмы
- Расширение `GitWorktreeService`: новые методы `createUserWorktree()` / `removeUserWorktree()` для одиночной пользовательской сессии, переиспользование существующей логики git операций, без изменений массовых интерфейсов используемых Arena
- Расширение `SessionService`: новое поле `WorktreeSession`, запись `{ slug, worktreePath, worktreeBranch, originalCwd, originalBranch }`; восстановление рабочей директории worktree при `--resume`
- Prompt инструментов: написать инструкции по использованию для каждого инструмента, указать когда вызывать, когда не вызывать

**Затрагиваемые файлы:**

| Файл                                                | Тип изменений                                      |
| --------------------------------------------------- | -------------------------------------------------- |
| `packages/core/src/tools/tool-names.ts`             | Новые константы `ENTER_WORKTREE`, `EXIT_WORKTREE`  |
| `packages/core/src/tools/EnterWorktreeTool/`        | Новая директория: `EnterWorktreeTool.ts`, `prompt.ts` |
| `packages/core/src/tools/ExitWorktreeTool/`         | Новая директория: `ExitWorktreeTool.ts`, `prompt.ts`  |
| `packages/core/src/services/gitWorktreeService.ts`  | Новые пользовательские интерфейсы сессии (без изменений интерфейсов Arena) |
| `packages/core/src/services/sessionService.ts`      | Новые поля и методы чтения/записи `WorktreeSession` |
| `packages/core/src/tools/` точка регистрации        | Регистрация новых инструментов                     |

**Не входит в Phase A:**

- Изоляция агента (Phase B)
- Post-creation setup типа настройки hooks (Phase C)
- Отображение статуса в UI (Phase C)

---

### Phase B: Изоляция агента (AgentTool `isolation: 'worktree'`) + обновление описаний

**Цель:** Модель может создавать временный изолированный worktree для subagent, автоматическая очистка после завершения агента; синхронное обновление описаний и подсказок затронутых инструментов.

**Функции для реализации:**

_Основное для изоляции агента:_

- Новый параметр `isolation?: 'worktree'` в `AgentTool`
- Создание временного worktree при запуске агента (slug: `agent-{7hex}`, путь: `.nessy/worktrees/agent-{7hex}`)
- После завершения агента: без изменений — автоматическое удаление; с изменениями — сохранение, возврат пути и ветки в результате
- Автоматическая очистка устаревших worktree: сканирование `.nessy/worktrees/`, совпадение по шаблону `agent-{7hex}`, удаление если старше 30 дней и без незапушенных коммитов, стратегия fail-closed

_Обновление описаний и подсказок:_

- Дополнить описание `AgentTool` параметром `isolation: 'worktree'` (см. claude-code `AgentTool/prompt.ts:272`)
- Новый `buildWorktreeNotice()`: при запуске fork subagent в worktree внедрить контекстную подсказку, объясняющую изоляцию worktree, наследование пути от родительского агента, необходимость повторного чтения файлов перед редактированием (см. claude-code `forkSubagent.ts:buildWorktreeNotice`)

_Не требует изменений:_

- review skill (`SKILL.md`): review использует независимый механизм (путь `.nessy/tmp/review-pr-<n>`, создание через команду `nessy review fetch-pr`), полностью отличается от универсального пути и механизма worktree, путаницы нет

**Гарантия совместимости Arena:** Arena внутренне не создаёт worktree через параметр `isolation`, это изменение не затрагивает код Arena.

**Затрагиваемые файлы:**

| Файл                                                | Тип изменений                                               |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `packages/core/src/tools/agent/agent.ts`            | Новый параметр `isolation` и логика создания/очистки worktree |
| `packages/core/src/tools/agent/fork-subagent.ts`    | Новый `buildWorktreeNotice()` и внедрение в режиме worktree |
| `packages/core/src/services/gitWorktreeService.ts`  | Новые `createAgentWorktree()` / `removeAgentWorktree()`     |
| `packages/core/src/services/worktreeCleanup.ts`     | Новый: логика автоматической очистки устаревших worktree    |

---

### Phase C: Улучшение опыта (Post-creation setup + UI)

**Цель:** Автоматическая инициализация окружения после создания worktree, видимость статуса в интерфейсе.

**Функции для реализации:**

- Post-creation setup: настройка `core.hooksPath` на главный репозиторий (в nessy-cli нет концепции `settings.local.json`, копирование не требуется)
- StatusLine отображает имя/ветку текущего worktree
- WorktreeExitDialog: при выходе из сессии (обнаружена активная worktree) предложить пользователю выбрать keep или remove
- Новая конфигурация `worktree.symlinkDirectories` для реализации символьных ссылок на директории

---

### Phase D: Расширенные функции

**Цель:** Полное выравнивание с claude-code.

**Функции для реализации:**

- Флаг запуска CLI `--worktree [name]`: создание worktree при запуске, вся сессия работает в изолированной среде
- Поддержка sparse checkout: новая конфигурация `worktree.sparsePaths`
- Файл `.worktreeinclude`: поддержка копирования в worktree файлов, игнорируемых gitignore
- Интеграция с tmux: `--worktree --tmux` запуск в сессии tmux
- Разрешение ссылок на PR: `--worktree=#123` автоматический fetch и создание worktree на основе PR
