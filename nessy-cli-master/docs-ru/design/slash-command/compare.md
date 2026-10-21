---
title: "Nessy CLI Command Module Refactoring Plan (План рефакторинга модуля команд)"
---

# Nessy CLI Command Module Refactoring Plan (План рефакторинга модуля команд)

## 1. Определение целей

Этот план использует следующее как единственную предпосылку:

- **Архитектура кода может не копировать Claude Code**
- **Но основные функции системы команд, пользовательский опыт, опыт взаимодействия должны быть на 95% выровнены с Claude Code**

«Выравнивание» здесь относится к возможностям, которые пользователь может непосредственно воспринимать, включая:

1. Покрытие источников команд
2. Справка по командам и обнаруживаемость
3. Автозаполнение команд и опыт mid-input slash command
4. Доступность ACP / non-interactive
5. Возможности вызова модели prompt command / skill

Этот рефакторинг — не добавление нескольких полей, не мелкое исправление существующего `SlashCommand`, а обновление модуля команд от «возможности интерактивного UI» до «единой платформы команд для interactive / ACP / non-interactive / model».

---

## 2. Переписанный вывод

Проблемы существующей системы команд Nessy не в полном отсутствии возможностей, а в том, что:

1. Относительно полна только на основном пути interactive
2. Слишком тонкая модель типов, не может нести уровень продукта Claude
3. Зависимость от белого списка ACP / non-interactive, очень плохая масштабируемость
4. Источники команд существуют, но не формируют единое ментальное представление для пользователя
5. Разделённая система отображения prompt command и моделей skill

Поэтому новое решение должно одновременно решать четыре вещи:

1. **Дополнить возможности Claude Code**
2. **Сохранить инженерные преимущества единой модели outcome Nessy**
3. **Установить единую архитектуру registry / resolver / executor / adapter**
4. **Заставить справку, автозаполнение, доступные команды ACP, документы использовать одни и те же метаданные**

---

## 3. Принципы рефакторинга

### 3.1 Функциональное выравнивание приоритетнее выравнивания реализации

Допустимы различия:

- Внутренние имена классов
- Способ разделения модулей
- Реализация исполнителя
- Структура effect / outcome

Недопустимы различия:

- Значительно сокращённое покрытие источников команд
- Значительно сокращённый опыт справки и автозаполнения команд
- Значительно сокращённая доступность ACP / non-interactive
- Значительно сокращённая интеграция prompt command и возможностей модели

Если есть выбор, приоритет должен быть:

1. Выравнивание пользовательского опыта
2. Выравнивание покрытия возможностей команд
3. Выравнивание согласованности режима
4. Простота внутренней реализации

### 3.2 Сохранение единой модели outcome Nessy

Не рекомендуется механически копировать реализацию выполнения Claude.

Единая модель outcome Nessy всё ещё стоит сохранения, потому что естественно подходит для:

- Перехвата UI
- Утверждения/подтверждения
- Планирования tool
- Отправки prompt
- Адаптации между режимами

Но она должна быть обновлена для возможности нести уровень команд Claude, а не продолжать существовать как упрощённая структура команд UI.

### 3.3 Тип, источник, режим, видимость должны быть полностью развязаны

Новая модель команд должна как минимум развязать следующие измерения:

1. **Тип**: как выполняется команда
2. **Источник**: откуда команда приходит
3. **Возможности режима**: в каких средах выполнения доступна
4. **Видимость**: видна пользователю или видна модели

---

## 4. Возможности Claude Code для выравнивания

### 4.1 Типы команд

Nessy должен явно поддерживать три типа команд:

1. `prompt`
2. `local`
3. `local-jsx`

### 4.2 Источники команд

Схема команд Nessy с первого этапа должна покрывать следующие источники:

1. built-in commands
2. bundled skills
3. skill dir commands
4. workflow commands
5. plugin commands
6. plugin skills
7. dynamic skills
8. mcp prompts
9. mcp skills

Здесь нельзя отступать к «сначала поддержим только те несколько типов, которые уже есть».

### 4.3 Метаданные команд

Как минимум дополнить следующие поля:

1. `argumentHint`
2. `whenToUse`
3. `examples`
4. `sourceLabel`
5. `userFacingName`
6. `alias`
7. `immediate`
8. `isSensitive`
9. `userInvocable`
10. `modelInvocable`
11. `supportedModes`
12. `requiresUi`

### 4.4 Возможности опыта

Как минимум дополнить следующие возможности:

1. Автозаполнение при совпадении alias
2. Source badge
3. Подсказка параметров
4. Сортировка recently used
5. Обнаружение и автозаполнение mid-input slash command
6. Помощь по каталогу команд
7. Полное выражение доступных команд ACP

---

## 5. Новая модель команд

## 5.1 Основная структура

Рекомендуется ввести единый `CommandDescriptor` как регистрационный формат для всех команд.

Он должен содержать как минимум четыре части:

1. `identity`
2. `metadata`
3. `capabilities`
4. `handler`

### `identity`

- `id`
- `name`
- `altNames`
- `canonicalPath`

### `metadata`

- `description`
- `argumentHint`
- `whenToUse`
- `examples`
- `group`
- `source`
- `sourceLabel`
- `userFacingName`
- `hidden`

### `capabilities`

- `type`: `prompt | local | local-jsx`
- `supportedModes`: `interactive | acp | non_interactive`
- `requiresUi`
- `supportsDialog`
- `supportsStreaming`
- `supportsToolInvocation`
- `supportsConfirmation`
- `remoteSafe`
- `readOnly`
- `immediate`
- `isSensitive`
- `userInvocable`
- `modelInvocable`

### `handler`

- `resolveArgs()`
- `execute()`
- `completion()`
- `fallback()`

---

## 5.2 Обязанности трёх типов команд

### `prompt`

Используется для:

- skills
- file commands
- workflow prompt commands
- plugin skills
- mcp prompt / skill

Особенности:

- Производит активы prompt / skill
- По умолчанию поддерживает interactive / ACP / non-interactive
- Может вызываться пользователем или моделью

### `local`

Используется для:

- Команд запросов
- Команд конфигурации
- Выполняемых команд состояния headless
- Большинства основных точек входа built-in команд

Особенности:

- Не зависит от UI
- Должен стать основным носителем ACP / non-interactive

### `local-jsx`

Используется для:

- picker
- Панели
- wizard
- Interactive UI shell

Особенности:

- Обрабатывает только interactive UI
- Больше не может быть единственным точкой входа выполнения
- Должен предоставлять fallback или соответствующую локальную подкоманду

---

## 6. Модель источников команд

## 6.1 Модель внешних источников

Это модель источников, видимая пользователю, должна максимально соответствовать ментальной модели Claude Code:

- `builtin-command`
- `bundled-skill`
- `skill-dir-command`
- `workflow-command`
- `plugin-command`
- `plugin-skill`
- `dynamic-skill`
- `builtin-plugin-skill`
- `mcp-prompt`
- `mcp-skill`

Эти поля будут напрямую использоваться для:

- Группировки Help
- Completion source badge
- Доступных команд ACP
- Экспорта документов

## 6.2 Модель внутренней нормализации

Чтобы не быть связанными внешними именами, внутренне добавляется уровень реализации:

- `providerType`
- `artifactType`
- `activationMode`
- `builtinProvided`
- `originPath`
- `namespace`

Это позволяет достичь:

- Внешний опыт выравнивается по Claude
- Внутренняя реализация остаётся поддерживаемой для Nessy

## 6.3 Стратегия конфликтов

Управление через стабильный `id`, разделение имени отображения и имени ввода:

1. `id`: стабильный уникальный идентификатор
2. `name`: основное имя ввода
3. `userFacingName`: имя отображения для справки/автозаполнения

Приоритет конфликтов:

1. built-in
2. bundled / skill-dir / workflow
3. plugin / builtin-plugin
4. dynamic
5. mcp независимое пространство имён

---

## 7. Единая архитектура выполнения

## 7.1 `CommandRegistry`

Обязанности:

1. Агрегировать все loader/provider
2. Создать многомерные индексы
3. Вывести представления help, completion, ACP, документов
4. Предоставить независимые представления видимых пользователю команд и видимых модели команд

Должен поддерживать provider:

1. `BuiltinCommandLoader`
2. `BundledSkillLoader`
3. `FileCommandLoader`
4. `McpPromptLoader`
5. `WorkflowCommandLoader`
6. `PluginCommandLoader`
7. `PluginSkillLoader`
8. `DynamicSkillProvider`
9. `BuiltinPluginSkillLoader`

Даже если некоторые provider ещё не полностью реализованы, схема и API должны быть поддержаны сначала.

## 7.2 `CommandResolver`

Обязанности:

1. Разрешать slash command
2. Разрешать alias
3. Разрешать путь subcommand
4. Распознавать mid-input slash token
5. Выводить каноническую разрешённую команду

## 7.3 `CommandExecutor`

Обязанности:

1. Проверка capabilities
2. Выполнение `prompt | local | local-jsx`
3. Единый вывод outcome
4. Обработка fallback / unsupported

## 7.4 `ModeAdapter`

Должны быть выделены три adapter:

1. `InteractiveModeAdapter`
2. `AcpModeAdapter`
3. `NonInteractiveModeAdapter`

Это позволяет трём режимам использовать один и тот же command registry и executor, а не жёсткое кодирование каждого.

---

## 8. Принципы рефакторинга UI команд: разделение основных команд и интерактивной оболочки

Это ключ к реальной доступности ACP и non-interactive.

Любая команда, которая по сути является «открытием диалога», должна быть преобразована в:

1. Interactive shell
2. Набор локальных подкоманд

### Первые команды для разделения

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

### Пример целевой формы

#### `/model`

- `/model`
- `/model show`
- `/model list`
- `/model set <id>`

#### `/permissions`

- `/permissions`
- `/permissions show`
- `/permissions set <mode>`
- `/permissions allow <tool>`
- `/permissions deny <tool>`

#### `/mcp`

- `/mcp`
- `/mcp list`
- `/mcp show <server>`
- `/mcp enable <server>`
- `/mcp disable <server>`

---

## 9. Единый дизайн Prompt Command / Skill

Это P0 в рефакторинге, не дополнительная возможность.

## 9.1 Цели

Создать единый **Model-Invocable Prompt Command Registry**, объединяющий следующие активы в единое представление, вызываемое моделью:

1. bundled skills
2. file commands
3. workflow prompt commands
4. plugin skills
5. mcp prompts / mcp skills

## 9.2 Ключевые поля

Должны быть добавлены:

1. `userInvocable`
2. `modelInvocable`
3. `allowedTools`
4. `whenToUse`
5. `argSchema` или минимальное описание параметров
6. `contextMode: inline | fork`
7. `agent`
8. `effort`

## 9.3 Отношение с `SkillTool`

После рефакторинга `SkillTool` больше не должен потреблять узкие skills.

Следует изменить на:

1. `CommandRegistry.getModelInvocablePromptCommands()` выводит единое представление
2. `SkillTool` или будущий единый command tool потребляет это представление
3. Пользовательская slash command и вызов модели skill используют один и тот же пул активов prompt-command

Это позволит Nessy приблизиться к тому, как Claude обрабатывает такие возможности, как `/review`, `/commit`, `/openspec-apply`.

---

## 10. Переделка Help / Completion / Discoverability

## 10.1 Completion

Элемент автозаполнения должен отображать как минимум:

1. `label`
2. `description`
3. `argumentHint`
4. `sourceBadge`
5. `modeBadges`
6. `aliasHit`
7. `recentlyUsedScore`

Сортировка должна учитывать как минимум:

1. Точное совпадение
2. Совпадение alias
3. Недавнее использование
4. Совпадение префикса
5. Нечёткое совпадение

## 10.2 Mid-input slash command

Должны быть дополнены:

1. Обнаружение slash token рядом с курсором
2. Подсказка ghost text
3. Завершение Tab
4. Подсветка действительных токенов команд

Первый этап сначала выравнивает опыт ввода; следует ли вводить более сильную «семантику выполнения встроенных команд» можно в последующих итерациях.

## 10.3 Help

Help больше не плоский список, а полный каталог команд.

Как минимум группировать:

1. Built-in Commands
2. Bundled Skills
3. Skill Dir Commands
4. Workflow Commands
5. Plugin Commands
6. Plugin Skills
7. Dynamic Skills
8. Builtin Plugin Skills
9. MCP Commands / MCP Skills

Каждая команда должна отображать как минимум:

1. Имя
2. Подсказка параметров
3. Описание
4. Источник
5. Поддерживаемые режимы
6. Вызываемость моделью
7. Сводка подкоманд

---

## 11. Рефакторинг ACP / Non-Interactive

## 11.1 Полностью отказаться от подхода белого списка

Старый план:

- built-in allowlist
- FILE / SKILL специальное рассмотрение
- Остальные типы результатов unsupported

Новый план:

- Каждая команда объявляет свои capabilities
- registry отвечает за фильтрацию
- adapter отвечает за выполнение и fallback

## 11.2 Целевая поддержка outcome

### interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `dialog`
- `load_history`
- `confirm_action`
- `confirm_shell_commands`

### acp

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback`

### non_interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback / structured failure`

## 11.3 Вывод доступных команд ACP

Должен содержать как минимум:

1. `name`
2. `description`
3. `argumentHint`
4. `source`
5. `examples`
6. `supportedModes`
7. `interactiveOnly`
8. `subcommands`
9. `modelInvocable`

---

## 12. Документы, справка, автозаполнение используют одни и те же метаданные

После рефакторинга следующее должно экспортироваться из одного представления registry:

1. Help
2. Completion
3. Доступные команды ACP
4. Экспорт документов

Это решает проблему «реализация, справка, документы — три разных представления команд».

---

## 13. Реализация по фазам

## Phase 1: Перестройка основания

Поставка:

1. Новый `CommandDescriptor`
2. Полная схема источников
3. Модель capability
4. `userInvocable / modelInvocable`
5. `CommandRegistry`
6. `CommandResolver`
7. `CommandExecutor`
8. Три `ModeAdapter`
9. `getModelInvocablePromptCommands()`

## Phase 2: Миграция основных команд

Поставка:

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

Эти команды должны завершить рефакторинг «interactive shell + локальные подкоманды».

## Phase 3: Интеграция возможностей модели

Поставка:

1. `SkillTool` подключается к единому представлению registry
2. file command / bundled skill / mcp prompt / plugin skill входят в единое множество model-invocable
3. Активы prompt command и skill полностью объединены

## Phase 4: Выравнивание уровня опыта с Claude

Поставка:

1. Сортировка recently used
2. source badge
3. argument hint
4. mode badge
5. Полный каталог help
6. Опыт mid-input slash command
7. Автоматический экспорт или проверка документов

---

## 14. Критерии приёмки

После завершения как минимум:

1. Help, completion, ACP, документы могут выражать полную модель источников
2. Кроме чисто UI-команд оболочки, большинство built-in команд доступны в ACP / non-interactive
3. Prompt command и вызов skill модели используют один и тот же пул активов
4. Опыт команд в справке, автозаполнении, выражении источников, подсказках параметров, опыте mid-input достигает уровня Claude Code на 95%
5. Больше не зависит от built-in allowlist для поддержания возможностей команд ACP / non-interactive

---

## 15. Окончательное решение

Суть этого рефакторинга не в «добавлении нескольких полей к существующему SlashCommand», а в:

- **Использовании внутреннего архитектурного стиля Nessy для доставки платформы команд, которая на 95% выравнивается с внешним опытом Claude Code**

Если нужно выбрать одно из двух:

- Внутренняя реализация больше похожа на Claude
- Внешний опыт больше похож на Claude

Этот план явно выбирает последнее.
