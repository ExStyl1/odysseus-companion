# Phase 3 Технический дизайн: Выравнивание опыта

## 1. Цели дизайна и ограничения

### 1.1 Цели

Phase 3 на основе реализованных в Phase 1/2 метаданных команд, кросс-режимной фильтрации и вызова модели prompt command, дополняет воспринимаемый пользователем опыт slash command:

- Дополнение меню автодополнения отображением источника, подсказок параметров, попадания alias, и введение сортировки недавно использованных на уровне сессии
- Совершенствование mid-input slash command с ghost text, подсказками параметров, отображением источника и подсветкой валидных токенов
- Реконструкция `/help` из текущей нагромождённой команды в разделённую по tab, ясную и красивую панель помощи в стиле Claude Code
- Улучшение метаданных команд ACP `available_commands_update`
- Подтверждение что реализованный `/doctor` не дублируется; `/release-notes` не включается в эту фазу

### 1.2 Жёсткие ограничения

- **Код как источник истины**: При различиях между документами Phase 1/2 и реализацией, приоритет у исходного кода главной ветки.
- **Не вводить новую архитектуру выполнения**: Продолжать переиспользовать существующие `SlashCommand`, `CommandService`, `handleSlashCommand`, `useSlashCompletion` и `Help` компоненты, не создавать новые `CommandDescriptor` / `CommandExecutor` / `ModeAdapter`.
- **Не восстанавливать `commandType`**: Текущая реализация удалила поле `commandType` из раннего дизайна Phase 1, Phase 3 не reintroduces это поле.
- **session-level recently used**: Сортировка недавно использованных действует только в пределах текущей CLI сессии, не персистируется на диск.
- **interactive поведение не деградирует**: Существующие interactive поведения автодополнения, help, doctor остаются рабочими; Phase 3 только улучшает отображение и дополняет отсутствующие команды.
- **ACP обратная совместимость**: Три существующих поля `availableCommands[].name`, `description`, `input` остаются неизменными; новые метаданные помещаются в совместимые поля или `_meta`, чтобы избежать поломки существующих ACP клиентов.

---

## 2. Текущая базовая линия (выводы аудита кода)

### 2.1 Существующие метаданные и поведение Loader

`packages/cli/src/ui/commands/types.ts` текущий `SlashCommand` уже содержит:

- `source?: CommandSource`
- `sourceLabel?: string`
- `supportedModes?: ExecutionMode[]`
- `userInvocable?: boolean`
- `modelInvocable?: boolean`
- `argumentHint?: string`
- `whenToUse?: string`
- `examples?: string[]`

`CommandSource` текущая поддержка:

```typescript
export type CommandSource =
  | 'builtin-command'
  | 'bundled-skill'
  | 'skill-dir-command'
  | 'plugin-command'
  | 'mcp-prompt';
```

Заполненная информация отображения каждым Loader:

| Loader                                  | source                                 | sourceLabel                              | argumentHint     | modelInvocable                                   |
| --------------------------------------- | -------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------ |
| `BuiltinCommandLoader`                  | `builtin-command`                      | `Built-in`                               | Большинство не объявлено | `false`                                          |
| `BundledSkillLoader`                    | `bundled-skill`                        | `Skill`                                  | Из skill       | `!disableModelInvocation`                        |
| `FileCommandLoader` / `command-factory` | `skill-dir-command` / `plugin-command` | `Custom` / `Plugin: <extensionName>`     | Из frontmatter | Пользователь/проект по умолчанию true; плагин требует description/whenToUse |
| `SkillCommandLoader`                    | `skill-dir-command` / `plugin-command` | `User` / `Project` / `Extension: <name>` | Из skill       | Пользователь/проект по умолчанию true; плагин требует description/whenToUse |
| `McpPromptLoader`                       | `mcp-prompt`                           | `MCP: <serverName>`                      | Не сгенерировано | Текущее не явно установлено `modelInvocable`                  |

> Примечание: Roadmap Phase 1 требовал MCP prompt `modelInvocable: true`, но текущая реализация не устанавливает явно. Phase 3 не меняет путь вызова модели MCP prompt; MCP prompt всё ещё вызывается через нативный механизм MCP, не через `SkillTool` посредник.

### 2.2 Текущие реализованные возможности Phase 3

| Возможность                                              | Текущее состояние                                                                                               | Ключевые файлы                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| mid-input slash базовый ghost text                       | Частично реализовано, только префиксное автодополнение для `modelInvocable` команд                            | `ui/utils/commandUtils.ts`, `ui/hooks/useCommandCompletion.tsx`  |
| line-start команда argument ghost text                   | Частично реализовано, показывает `argumentHint` когда команда полностью совпадает и без args                  | `ui/hooks/useCommandCompletion.tsx`                              |
| alias участие в совпадении                               | Совпадение и сортировка реализованы, но отображение всегда показывает все alias, не различает hit alias         | `ui/hooks/useSlashCompletion.ts`                                 |
| source badge                                             | Только MCP отображает `[MCP]`                                                                                   | `ui/components/SuggestionsDisplay.tsx`, `ui/components/Help.tsx` |
| `/help`                                                  | Текущая реализация считается незавершённой: хотя есть попытки группировки, всё ещё нагромождение команд, не имеет разделённой по tab, ясной читаемой панели помощи в стиле Claude Code | `ui/components/Help.tsx`                                         |
| ACP `argumentHint`                                       | Сопоставлено с `availableCommands[].input.hint`                                                                 | `acp-integration/session/Session.ts`                             |
| ACP source/supportedModes/subcommands/modelInvocable     | Не раскрыто                                                                                                     | `acp-integration/session/Session.ts`                             |
| Обработка конфликтов                                     | extension команды при конфликте переименовываются в `extensionName.commandName`, не-extension — последний загруженный перекрывает первый | `services/CommandService.ts`                                     |
| `/doctor`                                                | Реализовано, поддерживает `interactive` / `non_interactive` / `acp`                                           | `ui/commands/doctorCommand.ts`, `utils/doctorChecks.ts`          |

### 2.3 Заимствования из Claude Code

Спрованкиа `/Users/mochi/code/claude-code` исходный код:

- `src/types/command.ts`: Модель команды содержит `argumentHint`, `whenToUse`, `aliases`, `loadedFrom`, `kind`, `immediate`, `isSensitive`, `userFacingName`, `supportsNonInteractive` и другие поля отображения/возможностей.
- `src/utils/suggestions/commandSuggestions.ts`: Сортировка автодополнения одновременно учитывает точное попадание, попадание alias, prefix, fuzzy, skill usage; при попадании alias показывает только тот alias который пользователь фактически ввёл.
- `src/utils/suggestions/commandSuggestions.ts`: mid-input slash использует `findMidInputSlashCommand()`, `getBestCommandMatch()` и `findSlashCommandPositions()` для поддержки ghost text и подсветки.
- `src/components/HelpV2/Commands.tsx`: Help V2 — это просматриваемый каталог команд, отображение описания включает информацию об источнике.
- `src/commands.ts`: Claude Code имеет встроенные команды `/doctor`, `/release-notes` и т.д., Nessy CLI текущая реализовала `/doctor`; эта фаза не реализует `/release-notes`.

Phase 3 использует подход "выравнивание опыта, не копирование архитектуры" для заимствования вышеперечисленного.

---

## 3. Общее решение

### 3.1 Обзор изменений файлов

| Файл                                                    | Содержание изменений                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/cli/src/ui/components/SuggestionsDisplay.tsx` | Расширение типа `Suggestion`, отображение source badge, argumentHint, aliasHit |
| `packages/cli/src/ui/hooks/useSlashCompletion.ts`       | Генерация улучшенных элементов автодополнения; сортировка включает recently used; сохранение информации попадания alias |
| `packages/cli/src/ui/hooks/useCommandCompletion.tsx`    | mid-input ghost text переиспользует улучшенное совпадение; вывод argument/source метаданных для UI отображения |
| `packages/cli/src/ui/utils/commandUtils.ts`             | Добавить вспомогательную функцию подсветки slash token, или расширить существующую для возврата валидности команды |
| `packages/cli/src/ui/components/InputPrompt.tsx`        | Рендеринг валидных slash command token подсветки; сохранение Tab для принятия ghost text |
| `packages/cli/src/ui/components/Help.tsx`               | Реконструкция в разделённую по tab панель помощи в стиле Claude Code, избегание нагромождения команд |
| `packages/cli/src/ui/commands/helpCommand.ts`           | Если нужен non-interactive/acp текст помощи, расширить action; иначе только сохранить interactive UI |
| `packages/cli/src/acp-integration/session/Session.ts`   | Раскрыть улучшенные метаданные в ACP update |
| `packages/cli/src/ui/commands/*Command.ts`              | Дополнить `argumentHint` для распространённых built-in команд |

### 3.2 Новые общие инструменты отображения

Рекомендуется создать новый `packages/cli/src/services/commandMetadata.ts`, централизованно обрабатывать логику отображения необходимую Help, Completion, ACP:

```typescript
export function getCommandSourceBadge(cmd: SlashCommand): string | null;
export function getCommandSourceGroup(cmd: SlashCommand): CommandSourceGroup;
export function formatSupportedModes(cmd: SlashCommand): string;
export function getCommandDisplayName(cmd: SlashCommand): string;
export function getCommandSubcommandNames(cmd: SlashCommand): string[];
```

Не рекомендуется помещать эти функции отображения в Loader, чтобы избежать возложения UI логики на Loader.

---

## 4. Phase 3.1: Улучшение опыта автодополнения

### 4.1 Расширение структуры данных `Suggestion`

Текущая:

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;
}
```

Рекомендуется расширить до:

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;

  // Phase 3
  source?: CommandSource;
  sourceLabel?: string;
  sourceBadge?: string;
  argumentHint?: string;
  matchedAlias?: string;
  supportedModes?: ExecutionMode[];
  modelInvocable?: boolean;
}
```

Автодополнение файлов `mode !== 'slash'`, reverse search не нуждаются в заполнении этих полей.

### 4.2 Отображение source badge

Текущий `SuggestionsDisplay` только добавляет `[MCP]` для `CommandKind.MCP_PROMPT`. Phase 3 изменяет на использование `source` / `sourceLabel` для единой генерации badge:

| source / sourceLabel              | badge                                      |
| --------------------------------- | ------------------------------------------ |
| `builtin-command`                 | `[Built-in]` (опционально: по умолчанию не показывать, снизить шум) |
| `bundled-skill` / `Skill`         | `[Skill]`                                  |
| `skill-dir-command` / `User`      | `[User]`                                   |
| `skill-dir-command` / `Project`   | `[Project]`                                |
| `skill-dir-command` / `Custom`    | `[Custom]`                                 |
| `plugin-command` / `Plugin: x`    | `[Plugin]` или `[Plugin: x]`                |
| `plugin-command` / `Extension: x` | `[Extension]` или `[Extension: x]`          |
| `mcp-prompt`                      | `[MCP]`                                    |

Рекомендуемая реализация:

```typescript
function getCommandSourceBadge(cmd: SlashCommand): string | null {
  switch (cmd.source) {
    case 'bundled-skill':
      return '[Skill]';
    case 'skill-dir-command':
      return cmd.sourceLabel === 'User'
        ? '[User]'
        : cmd.sourceLabel === 'Project'
          ? '[Project]'
          : '[Custom]';
    case 'plugin-command':
      return '[Plugin]';
    case 'mcp-prompt':
      return '[MCP]';
    case 'builtin-command':
    default:
      return null;
  }
}
```

> Показывать ли `[Built-in]` решается читаемостью UI. В Help обязательно показывать Built-in группировку; в меню автодополнения можно опустить built-in badge, показывать badge только для не-встроенных источников.

### 4.3 Отображение argument hint

В меню автодополнения добавлять серый `argumentHint` после имени команды:

```text
/model <model-id>              Switch model
/export md|html|json|jsonl     Export current session
/review [pr-number] [--comment] [Skill] Review changed code
```

Рекомендации по реализации:

- `useSlashCompletion` заполняет `argumentHint: cmd.argumentHint` в `finalSuggestions`
- `SuggestionsDisplay` рендерит `argumentHint` с `theme.text.secondary` после label
- `commandColumnWidth` вычисление включает label + hint + badge, избегать смещения колонки описания
- Подкоманды автодополнения также поддерживают `argumentHint`

Сначала нужно дополнить `argumentHint` для распространённых built-in команд. Рекомендации первой партии:

| Команда          | argumentHint            |
| ---------------- | ----------------------- |
| `/model`         | `[--fast] [<model-id>]` |
| `/approval-mode` | `<mode>`                |
| `/language`      | `ui | output \<language\>` |
| `/export`        | `md | html | json | jsonl [path]` |
| `/memory`        | `show | add | refresh`  |
| `/mcp`           | `desc | nodesc | schema | auth | noauth` |
| `/stats`         | `[model | tools]`       |
| `/docs`          | Пусто или не устанавливать |
| `/doctor`        | Пусто или не устанавливать |

### 4.4 Сортировка recently used

#### 4.4.1 Хранение состояния

Поддерживать session-level состояние недавно использованных в `useSlashCommandProcessor` или `AppContainer`:

```typescript
type RecentSlashCommand = {
  name: string;
  usedAt: number;
  count: number;
};
```

Рекомендуется хранить как `Map<string, RecentSlashCommand>`, key использует финальное имя команды (т.е. `cmd.name` после обработки конфликтов).

#### 4.4.2 Момент записи

Записывать использование после успешного парсинга `commandToExecute` в `useSlashCommandProcessor.handleSlashCommand`:

- Не записывать если команда не найдена
- Можно не записывать hidden команды
- Вызов alias записывается по canonical `commandToExecute.name`
- Вызов подкоманды рекомендуется записывать полный путь родительской и leaf команды, первая фаза только записать leaf команду также приемлема

#### 4.4.3 Веса сортировки

Текущий порядок сортировки `compareRankedCommandMatches()`:

1. matchStrength
2. completionPriority
3. fzf score
4. match start
5. item length
6. original index

Phase 3 вставляет `recentScore`:

```typescript
return (
  right.matchStrength - left.matchStrength ||
  right.completionPriority - left.completionPriority ||
  right.recentScore - left.recentScore ||
  right.score - left.score ||
  left.start - right.start ||
  left.itemLength - right.itemLength ||
  left.originalIndex - right.originalIndex
);
```

`recentScore` рекомендация:

```typescript
const RECENT_DECAY_MS = 10 * 60 * 1000;
const recentScore = count * 10 + Math.max(0, 10 - ageMs / RECENT_DECAY_MS);
```

Когда query пуст (пользователь ввёл только `/`), recently used команды наверху; когда query не пуст, только при одинаковой силе совпадения добавлять вес, избегать чтобы recent команды подавляли явно более точные совпадения.

### 4.5 Отображение попадания alias

Текущий alias уже участвует в `AsyncFzf` и prefix fallback, но `formatSlashCommandLabel()` всегда показывает все alias:

```text
help (?)
compress (summarize)
```

Phase 3 изменяет на:

- Когда пользователь ввёл попадание на главное имя: не показывать дополнительно alias, или сохранить существующий лаконичный формат
- Когда пользователь ввёл попадание на alias: показывать `help (alias: ?)`
- `Suggestion.matchedAlias` записывается на этапе совпадения

Рекомендации по реализации:

```typescript
function findMatchedAlias(
  cmd: SlashCommand,
  query: string,
): string | undefined {
  return cmd.altNames?.find((alt) =>
    alt.toLowerCase().startsWith(query.toLowerCase()),
  );
}
```

В результатах FZF, если `result.item` из `altNames`, можно напрямую использовать как `matchedAlias`; prefix fallback аналогично.

---

## 5. Phase 3.2: mid-input slash command полная версия

### 5.1 Текущее поведение

Текущий `findMidInputSlashCommand()` только распознаёт "/xxx token разделённый пробелами", и требует чтобы cursor был в конце token; `getBestSlashCommandMatch()` только делает алфавитный prefix match для `modelInvocable` команд.

Это соответствует базовой цели Phase 2, но Phase 3 нуждается в дополнении отображения и подсветки.

### 5.2 Улучшение ghost text

Сохранить текущую стратегию: mid-input slash подсказывает только `modelInvocable` команды, потому что встроенные команды в тексте не выполняются как slash command.

Улучшения:

- Алгоритм совпадения от алфавитного prefix изменить на переиспользование правил сортировки `useSlashCompletion` (как минимум учесть `completionPriority` и recently used)
- Расширить структуру возврата:

```typescript
export type BestSlashCommandMatch = {
  suffix: string;
  fullCommand: string;
  command: SlashCommand;
  sourceBadge?: string;
  argumentHint?: string;
};
```

### 5.3 mid-input source badge и argument hint

Из-за ограниченного пространства ghost text, не рекомендуется помещать badge и hint напрямую в тело ghost text. Рекомендации отображения:

- ghost text всё ещё рендерит только суффикс имени команды, например ввод `please /rev` отображает `iew`
- Когда token полностью совпал с командой и команда имеет `argumentHint`, показывать бледную подсказку параметров после cursor, например `/review [pr-number] [--comment]`
- source badge показывать только в dropdown или подсказке статуса; если mid-input не показывает dropdown, можно не принудительно показывать badge

### 5.4 Подсветка валидных token команд

Заимствовать Claude Code `findSlashCommandPositions()`, в `InputPrompt.renderLineWithHighlighting()` раскрашивать валидные slash command token в тексте.

Рекомендуется новая вспомогательная функция:

```typescript
export type SlashCommandToken = {
  start: number;
  end: number;
  commandName: string;
  valid: boolean;
};

export function findSlashCommandTokens(
  text: string,
  commands: readonly SlashCommand[],
): SlashCommandToken[];
```

Правила:

- token должен быть в начале строки или предыдущий символ должен быть пробелом
- token вида `/[a-zA-Z][a-zA-Z0-9:_-]*`
- Для mid-input подсветки только `modelInvocable` команды считать valid
- line-start token может считать все interactive видимые команды valid
- valid token использовать accent цвет; invalid token сохранять обычный текст, избегать ошибочной подсветки путей `/usr/bin` как команд

---

## 6. Phase 3.3: Реконструкция каталога Help

### 6.1 Текущие проблемы

`Help.tsx` текущий вывод:

- Basics
- Плоский `Commands:`
- `[MCP]` описание
- Keyboard Shortcuts

Проблемы:

- Все источники перемешаны, skill, custom, plugin, MCP трудно различить
- Не показывает `argumentHint`
- Не показывает `supportedModes`
- Не показывает `modelInvocable`
- Подкоманды только с отступом первого уровня, не показывают источник/mode

### 6.2 Дизайн группировки

Группировка по `source` / `sourceLabel`:

1. **Built-in Commands**: `source === 'builtin-command'`
2. **Bundled Skills**: `source === 'bundled-skill'`
3. **Custom Commands**: `source === 'skill-dir-command'`, включает `Custom` / `User` / `Project`
4. **Plugin Commands**: `source === 'plugin-command'`, включает `Plugin:*` / `Extension:*`
5. **MCP Commands**: `source === 'mcp-prompt'`
6. **Other Commands**: source отсутствует, совместимость fallback

Внутри каждой группы сортировка по имени команды; hidden команды не показываются.

### 6.3 Отображение полей для каждой команды

Рекомендуемый формат:

```text
/model [--fast] [<model-id>]  Switch model
  source: Built-in  modes: interactive, non_interactive, acp

/review [pr-number] [--comment]  Review changed code
  source: Skill  modes: interactive, non_interactive, acp  model: yes
```

Чтобы избежать чрезмерной ширины Help, рекомендуется сжать в одну строку:

```text
 /review [pr-number] [--comment] [Skill] [all] [model] - Review changed code
```

Рекомендации mode badge:

| supportedModes                      | badge            |
| ----------------------------------- | ---------------- |
| `interactive` only                  | `[interactive]`  |
| `interactive, non_interactive, acp` | `[all]`          |
| `non_interactive, acp`              | `[headless]`     |
| Другие комбинации                   | `[i] [ni] [acp]` |

### 6.4 Расширение `/help` на headless

Roadmap только требует чтобы `/help` выводил группировку по источникам, не требует явно non-interactive/acp. Текущий `/help` это `supportedModes: ['interactive']`.

Phase 3 рекомендует новый headless путь, но как отдельная подзадача:

- `supportedModes` изменить на all modes
- interactive: продолжать рендерить `HistoryItemHelp`
- non_interactive/acp: вернуть текстовую группированную директорию `message`

Если scope нуждается в сужении, можно сначала только реконструировать interactive `Help` компонент, headless `/help` отложить.

---

## 7. Phase 3.4: Улучшение метаданных ACP available commands

### 7.1 Текущий вывод ACP

`Session.sendAvailableCommandsUpdate()` текущее отображение `SlashCommand[]` в:

```typescript
{
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
}
```

Где `argumentHint` уже раскрыт через `input.hint`.

### 7.2 План улучшения

Если тип `AvailableCommand` протокола ACP не может напрямую добавить поля, использовать `_meta` для совместимости:

```typescript
const availableCommands: AvailableCommand[] = slashCommands.map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
  _meta: {
    argumentHint: cmd.argumentHint,
    source: cmd.source,
    sourceLabel: cmd.sourceLabel,
    supportedModes: cmd.supportedModes ?? getEffectiveSupportedModes(cmd),
    subcommands: cmd.subCommands
      ?.filter((sub) => !sub.hidden)
      .map((sub) => sub.name),
    modelInvocable: cmd.modelInvocable === true,
  },
}));
```

Если тип `AvailableCommand` позволяет расширенные поля, предпочтительно вывести как первоклассные поля:

```typescript
{
  name,
  description,
  input,
  argumentHint,
  source,
  supportedModes,
  subcommands,
  modelInvocable,
}
```

Но всё же рекомендуется сохранить `_meta` зеркало на некоторое время для постепенной миграции старых клиентов.

### 7.3 Стратегия рекурсии subcommands

Критерии приёмки требуют только список имён `subcommands`. Первая фаза вывода одного уровня подкоманд достаточна:

```typescript
subcommands: cmd.subCommands?.map((sub) => sub.name) ?? [];
```

В будущем если ACP клиент нуждается в многоуровневом дереве, можно расширить до:

```typescript
type AcpSubcommandMeta = {
  name: string;
  description?: string;
  argumentHint?: string;
  subcommands?: AcpSubcommandMeta[];
};
```

---

## 8. Phase 3.5: Восполнение отсутствующих команд Claude Code

### 8.1 `/doctor`: уже реализован, не дублировать

Текущий `doctorCommand` уже существует:

- Файл: `packages/cli/src/ui/commands/doctorCommand.ts`
- Регистрация: `BuiltinCommandLoader`
- Режим: `['interactive', 'non_interactive', 'acp']`
- interactive: отображает `HistoryItemDoctor`
- non_interactive/acp: возвращает JSON `message`
- Диагностическая логика: `packages/cli/src/utils/doctorChecks.ts`

Phase 3 только нужно правильно отобразить источник и mode для `/doctor` в Help и автодополнении; при необходимости оптимизации, можно изменить headless JSON на более читаемый Markdown, но это не обязательно.

### 8.2 `/release-notes`: не включается в эту фазу

`/release-notes` больше не является требованием Phase 3. Эта фаза не добавляет новых команд, не регистрирует built-in, не пишет соответствующих тестов, чтобы избежать введения command surface без явных продуктовых требований.

---

## 9. Подтверждение и отображение стратегии конфликтов

Текущая стратегия конфликтов `CommandService`:

- extension/plugin команды при совпадении имени с существующей командой переименовываются в `extensionName.commandName`
- При вторичном конфликте добавляется числовой суффикс: `extensionName.commandName1`
- Не extension команды при совпадении имени, последняя загруженная перезаписывает предыдущую

Phase 3 не меняет семантику выполнения, только ясно отображает финальное имя и источник в Help/Completion.

Рекомендуется дополнить тесты для обеспечения:

- Переименованная plugin command отображает финальное имя и `[Plugin]` badge в автодополнении
- Help отображает финальное имя в группе Plugin Commands
- ACP вывод использует финальное имя

> Приоритет "built-in > bundled/skill-dir > plugin > mcp" в roadmap не полностью согласуется с текущей реализацией "не extension последняя загруженная перезаписывает предыдущую". Phase 3 документ основывается на текущем исходном коде `CommandService`, не меняет семантику конфликтов в этой фазе; если требуется строгая корректировка приоритета, следует обработать как отдельную Phase, чтобы избежать изменения поведения перекрытия пользовательских/проектных команд.

---

## 10. Стратегия тестирования

### 10.1 Тесты автодополнения

Обновить или создать:

- `packages/cli/src/ui/hooks/useSlashCompletion.test.ts`
- `packages/cli/src/ui/hooks/useCommandCompletion.test.ts`
- `packages/cli/src/ui/components/SuggestionsDisplay.test.tsx` (если текущий файл отсутствует, создать)

Покрытие:

- source badge: Skill/Custom/Plugin/MCP правильное отображение
- argumentHint: показывать hint после имени команды, и ширина колонки не разрушает описание
- recently used: при вводе только `/` недавние команды впереди; при вводе явного query точное совпадение приоритетно
- alias попадание: ввод `?` отображает `help (alias: ?)`, ввод `/he` не показывает ошибочно alias попадание
- mid-input ghost: текст `/rev` подсказывает modelInvocable `/review` суффикс
- mid-input не подсказывает built-in: текст `/sta` не подсказывает `/stats` (если только будущий дизайн не разрешает встроенное выполнение)

### 10.2 Help тесты

Обновить: `packages/cli/src/ui/components/Help.test.tsx`

Покрытие:

- Группировка по Built-in/Bundled Skills/Custom/Plugin/MCP
- hidden команды не отображаются
- Подкоманды отображают список имён
- `argumentHint`, source badge, mode badge, model badge правильное появление
- altNames всё ещё могут отображаться, но не мешают главному имени команды

### 10.3 ACP тесты

Обновить: `packages/cli/src/acp-integration/session/Session.test.ts`

Покрытие:

- `availableCommands[].input.hint` сохраняет текущее поведение
- Новые метаданные содержат `argumentHint`, `source`, `sourceLabel`, `supportedModes`, `subcommands`, `modelInvocable`
- Команды без `argumentHint` `input: null` сохраняют совместимость
- `getAvailableCommands(config, signal, 'acp')` вызов остаётся неизменным

### 10.4 Тесты новых команд

Эта фаза не добавляет `/release-notes` или другие built-in команды, поэтому не нужны новые тесты команд. Только сохранить существующие регрессионные тесты `/doctor`.

### 10.5 План E2E тестирования

Phase 3 одновременно изменяет TUI автодополнение, выполнение slash command, ACP command metadata, unit тесты не могут покрыть полный пользовательский путь. E2E верификация делится на три категории:

1. **Построение локального CLI**: Сначала запустить `npm run build && npm run bundle`, затем использовать `node dist/cli.js` для верификации локальной реализации.
2. **Interactive / tmux сценарии**: Для верификации меню автодополнения, ghost text, Tab принятие, Help рендеринг и других TUI поведений.
3. **Headless / JSON сценарии**: Для верификации non-interactive slash command вывода, не зависит от TUI.
4. **ACP integration сценарии**: Для верификации метаданных `available_commands_update`.

#### 10.5.1 E2E предварительные шаги

```bash
npm run build && npm run bundle
```

Interactive сценарий рекомендуется использовать отдельную временную директорию, чтобы избежать загрязнения текущего репозитория:

```bash
tmux new-session -d -s nessy-slash-phase3 -x 200 -y 50 \
  "cd /tmp/nessy-slash-phase3 && /Users/mochi/code/nessy-cli-test/dist/cli.js --approval-mode auto-edit"
sleep 3
```

Отправка ввода разбивает текст и enter, избегать чтобы TUI поглощало отправку:

```bash
tmux send-keys -t nessy-slash-phase3 "/help"
sleep 0.5
tmux send-keys -t nessy-slash-phase3 Enter
```

Захват вывода:

```bash
tmux capture-pane -t nessy-slash-phase3 -p -S -100
```

Очистка:

```bash
tmux kill-session -t nessy-slash-phase3
```

#### 10.5.2 Список E2E тестов

| Сценарий              | Режим            | Шаги                                                                                   | Ожидаемый результат                                                                                                                        |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Автодополнение source badge | interactive/tmux | Ввод `/`, наблюдение меню автодополнения                                              | skill/custom/plugin/MCP команды отображают соответствующий source badge; built-in можно не показывать badge                               |
| Автодополнение argument hint | interactive/tmux | Ввод `/model`, `/export`                                                              | После имени команды показывать `argumentHint`; команды без параметров не показывают шумный hint                                          |
| Сортировка recently used | interactive/tmux | Сначала выполнить `/help`, затем ввод `/`                                             | `/help` появляется приоритетно при одинаковых условиях совпадения; точный query всё ещё приоритетно совпадает                             |
| Отображение попадания alias | interactive/tmux | Ввод `/?`                                                                             | Элемент автодополнения отображает `help (alias: ?)`; ввод `/he` не показывает ошибочно попадание alias                                   |
| mid-input ghost text | interactive/tmux | Ввод `please /rev` в тексте                                                           | Появляется суффикс ghost text `/review`, Tab может принять                                                                                |
| mid-input token подсветка | interactive/tmux | Ввод текста содержащего `/review`                                                     | Валидный model-invocable slash token использует командную подсветку; пути `/usr/bin` не подсвечиваются как команды                        |
| Help группированная директория | interactive/tmux | Выполнение `/help`                                                                    | Вывод содержит группы Built-in Commands, Bundled Skills, Custom Commands, Plugin Commands, MCP Commands; каждая команда отображает source/mode/hint |
| `/doctor` headless регрессия | headless/json | Выполнение `node dist/cli.js "/doctor" --approval-mode yolo --output-format json 2>/dev/null` | Возвращает `message`, не триггерит TUI-only компонент ошибки                                                                              |
| ACP metadata          | integration      | Запуск ACP session и триггер `available_commands_update`                              | Каждая команда сохраняет `name`, `description`, `input.hint`, и содержит `argumentHint`, `source`, `supportedModes`, `subcommands`, `modelInvocable` |

#### 10.5.3 Примеры headless команд

`/release-notes` не включается в эту фазу; headless регрессия только сохраняет `/doctor` и другие существующие команды для верификации.

### 10.6 Команды регрессионного тестирования

Согласно AGENTS.md, приоритетно запускать тесты одиночных файлов:

```bash
cd packages/cli && npx vitest run src/ui/hooks/useSlashCompletion.test.ts
cd packages/cli && npx vitest run src/ui/hooks/useCommandCompletion.test.ts
cd packages/cli && npx vitest run src/ui/components/Help.test.tsx
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

Финальная верификация:

```bash
npm run build && npm run typecheck
npm run build && npm run bundle
```

---

## 11. Критерии приёмки

### 11.1 Меню автодополнения

- [ ] Меню автодополнения отображает source badge (как минимум `[MCP]`, `[Skill]`, `[Custom]`, `[Plugin]`)
- [ ] Меню автодополнения отображает `argumentHint`
- [ ] В пределах сессии недавно использованные команды приоритетно появляются при вводе только `/`
- [ ] При попадании alias отображать `alias: <alias>`, при непопадании alias не показывать шумно
- [ ] Plugin/extension конфликт переименования команды отображает финальное имя и источник в автодополнении

### 11.2 mid-input slash

- [ ] При вводе `/review` (model-invocable команды) в тексте ghost text правильно подсказывает
- [ ] Tab может принять mid-input ghost text
- [ ] Валидный mid-input slash command token подсветка
- [ ] Built-in команды не подсказываются ошибочно как выполняемые встроенные команды в тексте
- [ ] Подсказка параметров отображается при полном совпадении команды и без args

### 11.3 Help

- [ ] `/help` отображает команды группировкой по источнику
- [ ] Каждая команда отображает имя, `argumentHint`, description, source, supportedModes marker
- [ ] model-invocable команды имеют явный marker
- [ ] Подкоманды отображаются списком имён или отступом
- [ ] hidden команды не отображаются

### 11.4 ACP

- [ ] ACP `available_commands_update` продолжает содержать `name`, `description`, `input.hint`
- [ ] ACP command метаданные содержат `argumentHint`, `source`, `supportedModes`, `subcommands`, `modelInvocable`
- [ ] Старые клиенты при игнорировании новых полей не затрагиваются

### 11.5 Отсутствующие команды

- [ ] `/doctor` всё ещё доступен, и non-interactive возвращает `message`
- [ ] Не добавлять `/release-notes`, документация, тесты и критерии приёмки больше не требуют эту команду

---

## 12. Не цели

Следующее содержание не включается в Phase 3:

- Не реализовывать workflow command / dynamic skill / mcp skill новый Loader
- Не вводить персистентный command usage tracking
- Не изменять протокол вызова модели `SkillTool`
- Не изменять путь вызова модели MCP prompt
- Не рефакторить command исполнитель или mode adapter
- Не изменять существующую семантику перекрытия user/project command

---

## 13. Рекомендуемый порядок реализации

1. **Структура данных автодополнения и отображение badge/hint**: Сначала расширить `Suggestion` и `SuggestionsDisplay`, низкий риск, наглядная обратная связь.
2. **Дополнение built-in `argumentHint`**: Позволить существующему ghost text и ACP `input.hint` немедленно получить выгоду.
3. **Сортировка recently used**: Ввести recent score в `useSlashCompletion`, дополнить тесты.
4. **Отображение попадания alias**: Корректировать FZF/prefix совпадение для сохранения `matchedAlias`.
5. **Реконструкция Help с разделением по tab**: Предоставить ясные панели General / Commands / Custom Commands и т.д. в стиле Claude Code, избегать нагромождения команд.
6. **Улучшение метаданных ACP**: Расширить `Session.sendAvailableCommandsUpdate()`, сохранить `_meta` совместимость.
7. **Улучшение подсветки mid-input**: Последняя обработка уровня рендеринга, избегать слишком больших параллельных изменений с логикой автодополнения.
