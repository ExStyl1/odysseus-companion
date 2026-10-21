# Phase 1 Technical Design Document: Infrastructure Reconstruction (Технический дизайн Phase 1: Перестройка инфраструктуры)

## 1. Цели дизайна и ограничения

### 1.1 Цели

- Создать единую модель метаданных команд, покрывающую четыре измерения: источник (source), тип выполнения (commandType), возможности режима (supportedModes), видимость (userInvocable / modelInvocable)
- Заменить жёстко закодированные белые списки в non-interactive/acp на фильтрацию на основе capabilities
- Предоставить стабильные нижележащие интерфейсы для расширения возможностей в Phase 2/3

### 1.2 Жёсткие ограничения

- **Нулевые изменения поведения**: существующие наборы доступных команд в режимах non-interactive и acp остаются неизменными (исключение: исправление ошибочного перехвата MCP_PROMPT, это bug fix)
- **Обратная совместимость**: новые поля интерфейса `SlashCommand` необязательны или имеют разумные значения по умолчанию, существующий код команд не требует немедленного изменения
- **Не создавать новые исполнители**: не создавать новые архитектуры выполнения, такие как ModeAdapter / CommandExecutor, только расширять существующие CommandService и логику фильтрации
- **Не изменять существующие возможности команд**: не добавлять новые локальные подкоманды для любых команд, не изменять реализации action любых команд

---

## 2. Новые определения типов

### 2.1 Расположение файлов

Все новые определения типов в `packages/cli/src/ui/commands/types.ts`, вместе с существующим интерфейсом `SlashCommand`.

### 2.2 `ExecutionMode`

```typescript
/**
 * Тип режима выполнения.
 * - interactive: режим React/Ink UI (терминальное взаимодействие)
 * - non_interactive: режим CLI без взаимодействия (текстовый/JSON вывод)
 * - acp: режим интеграции ACP/Zed
 */
export type ExecutionMode = 'interactive' | 'non_interactive' | 'acp';
```

### 2.3 `CommandSource`

```typescript
/**
 * Тип источника команды, для группировки Help, badge автозаполнения, отображения доступных команд ACP.
 *
 * Отличие от CommandKind:
 * - CommandKind — внутренняя классификация загрузчика (4 типа), влияет на логику загрузки
 * - CommandSource — классификация источника для пользователя (9 типов), влияет на отображение и ментальную модель
 *
 * Они могут перекрываться, но обязанности разные, не объединяются.
 */
export type CommandSource =
  | 'builtin-command' // Встроенные команды (BuiltinCommandLoader)
  | 'bundled-skill' // Skill, распространяемые с пакетом (BundledSkillLoader)
  | 'skill-dir-command' // Файловые команды в пользовательских/проектных .nessy/commands/ (FileCommandLoader, не плагины)
  | 'plugin-command' // Команды, предоставляемые плагинами (FileCommandLoader, extensionName не пуст)
  | 'mcp-prompt'; // Prompt, предоставляемые MCP server (McpPromptLoader)
// Источники зарезервированы, Phase 1 не реализует соответствующие Loader, но схема определена заранее:
// | 'workflow-command'
// | 'plugin-skill'
// | 'dynamic-skill'
// | 'builtin-plugin-skill'
// | 'mcp-skill'
```

### 2.4 `CommandType`

```typescript
/**
 * Тип выполнения команды, описывает "как выполняется" команда.
 *
 * - prompt: генерирует submit_prompt, отправляет контент модели. Подходит для skill, file command, MCP prompt.
 *   По умолчанию supportedModes — все режимы, по умолчанию modelInvocable — true.
 *
 * - local: выполняет логику локально, не зависит от React/Ink UI. Может возвращать message, stream_messages,
 *   submit_prompt, tool и т.д. Подходит для запросов, конфигурации, состояния built-in команд.
 *   По умолчанию supportedModes — ['interactive'], требует явного объявления supportedModes для открытия другим режимам.
 *   Это семантически согласуется с supportsNonInteractive: true в Claude Code — поддержка неинтерактивности требует явного объявления, а не автоматического вывода.
 *
 * - local-jsx: команды, зависящие от React/Ink UI (открытие диалога, рендеринг JSX-компонентов и т.д.).
 *   По умолчанию supportedModes только ['interactive'].
 */
export type CommandType = 'prompt' | 'local' | 'local-jsx';
```

### 2.5 Расширение интерфейса `SlashCommand`

Добавление новых полей к существующему интерфейсу, **все необязательны** для обеспечения обратной совместимости:

```typescript
export interface SlashCommand {
  // ── Существующие поля (без изменений) ──────────────────────────────────────────────
  name: string;
  altNames?: string[];
  description: string;
  hidden?: boolean;
  completionPriority?: number;
  kind: CommandKind;
  extensionName?: string;
  action?: (...) => ...;
  completion?: (...) => ...;
  subCommands?: SlashCommand[];

  // ── Phase 1 добавлено: источник и тип выполнения ──────────────────────────────────────
  /**
   * Источник команды, для группировки Help, badge автозаполнения, отображения доступных команд ACP.
   * Заполняется каждым Loader, не объявляется самой командой.
   * При будущем удалении CommandKind, source станет единственным идентификатором источника.
   */
  source?: CommandSource;

  /**
   * Метка источника для отображения, ориентированная на пользователя.
   * - builtin-command → "Built-in"
   * - bundled-skill → "Skill"
   * - skill-dir-command → "Custom"
   * - plugin-command → "Plugin: <extensionName>"
   * - mcp-prompt → "MCP: <serverName>"
   * Заполняется каждым Loader, может быть переопределено самой командой.
   */
  sourceLabel?: string;

  /**
   * Тип выполнения команды.
   * - Заполняется Loader по умолчанию (prompt/local-jsx)
   * - built-in команды объявляются самим файлом команды (local или local-jsx)
   * Стратегия по умолчанию при отсутствии объявления см. getEffectiveCommandType().
   */
  commandType?: CommandType;

  // ── Phase 1 добавлено: возможности режима ──────────────────────────────────────────
  /**
   * В каких режимах выполнения доступна эта команда.
   * При отсутствии объявления выводится из commandType (см. getEffectiveSupportedModes()).
   * Явное объявление имеет приоритет над выводом.
   */
  supportedModes?: ExecutionMode[];

  // ── Phase 1 добавлено: видимость ──────────────────────────────────────────────
  /**
   * Может ли пользователь вызывать эту команду через slash command.
   * По умолчанию true (почти все команды userInvocable).
   */
  userInvocable?: boolean;

  /**
   * Может ли модель вызывать эту команду через вызов инструмента.
   * По умолчанию false. Команды типа prompt (skill, file command, MCP prompt) должны быть установлены в true.
   * built-in команды не разрешены для вызова моделью (всегда false).
   */
  modelInvocable?: boolean;

  // ── Phase 3 зарезервировано: метаданные опыта (Phase 1 только определяет, не использует) ───────────────────
  /**
   * Подсказка параметров, отображается после имени команды в меню автозаполнения.
   * Пример: "<model-id>" / "show|list|set <id>" / "[--fast] [<model-id>]"
   */
  argumentHint?: string;

  /**
   * Описание для понимания моделью, когда вызывать эту команду.
   * Будет внедрено в description команд modelInvocable.
   */
  whenToUse?: string;

  /**
   * Примеры использования, для каталога Help и отображения автозаполнения.
   */
  examples?: string[];
}
```

---

## 3. Спецификации заполнения полей для каждого Loader

### 3.1 Принципы заполнения

- `source` и `sourceLabel` заполняются Loader при построении `SlashCommand`, не объявляются самой командой
- `commandType`: Loader заполняет значение по умолчанию; built-in команды объявляются самим файлом команды
- `supportedModes`: выводится через `getEffectiveSupportedModes()`, не требует явного заполнения (если не нужно переопределить значение по умолчанию)
- `modelInvocable`: заполняется Loader, built-in команды всегда `false`, команды типа prompt — `true`

### 3.2 `BuiltinCommandLoader`

```typescript
// Не заполнять source/sourceLabel/commandType — объявляются каждым файлом команды
// Потому что commandType built-in команд — local или local-jsx, требует пометки по одной

// Внедрить source и sourceLabel:
for (const cmd of rawCommands) {
  enrichedCommands.push({
    ...cmd,
    source: 'builtin-command',
    sourceLabel: 'Built-in',
    userInvocable: cmd.userInvocable ?? true,
    modelInvocable: false, // built-in команды не разрешены для вызова моделью
  });
}
```

### 3.3 `BundledSkillLoader`

```typescript
return skills.map((skill) => ({
  name: skill.name,
  description: skill.description,
  kind: CommandKind.SKILL,
  source: 'bundled-skill' as CommandSource,
  sourceLabel: 'Skill',
  commandType: 'prompt' as CommandType,
  userInvocable: true,
  modelInvocable: true,
  action: async (...) => { ... },
}));
```

### 3.4 `FileCommandLoader`

```typescript
// В createSlashCommandFromDefinition:
return {
  name: baseCommandName,
  description,
  kind: CommandKind.FILE,
  extensionName,
  // source определяется по extensionName:
  source: extensionName ? 'plugin-command' : 'skill-dir-command',
  sourceLabel: extensionName ? `Plugin: ${extensionName}` : 'Custom',
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: !extensionName, // команды плагинов временно не разрешены для вызова моделью, пользовательские/проектные команды разрешены
  action: async (...) => { ... },
};
```

> **Заметка**: команды плагинов (plugin-command) временно не помечаются как `modelInvocable`, чтобы избежать проблем безопасности. В последующих Phase можно открыть по требованию, контролируется пользователем через конфигурацию.

### 3.5 `McpPromptLoader`

```typescript
const newPromptCommand: SlashCommand = {
  name: commandName,
  description: prompt.description || `Invoke prompt ${prompt.name}`,
  kind: CommandKind.MCP_PROMPT,
  source: 'mcp-prompt',
  sourceLabel: `MCP: ${serverName}`,
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: true,
  // ... остальные существующие поля
};
```

---

## 4. Спецификации объявления `commandType` для built-in команд

### 4.1 Критерии классификации

| commandType | Критерий                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`     | action использует только `ui.addItem` (текстовый тип), возвращает `message` / `stream_messages` / `submit_prompt` / `tool`, не зависит от рендеринга React-компонентов                                    |
| `local-jsx` | action возвращает `dialog`, или action вызывает `ui.addItem` с передачей сложного типа с JSX (например, `HistoryItemHelp`, `HistoryItemStats`), или зависит от `confirm_action` / `load_history` / `quit` |

> **Заметка**: `ui.addItem(message/error/info тип)` — это `local`; `ui.addItem(help/stats/tools/about и т.д. сложные UI типы)` — это `local-jsx`.

### 4.2 Таблица классификации built-in команд

**Класс `local`** (объявить `commandType: 'local'`, `supportedModes` выводится как all modes):

| Файл команды         | Имя команды | Описание                                                                |
| -------------------- | ----------- | ----------------------------------------------------------------------- |
| `btwCommand.ts`      | `btw`       | Возвращает `submit_prompt` или `stream_messages`                        |
| `bugCommand.ts`      | `bug`       | Возвращает `submit_prompt` или `stream_messages`                        |
| `compressCommand.ts` | `compress`  | Уже имеет адаптацию executionMode, возвращает `message`/`submit_prompt` |
| `contextCommand.ts`  | `context`   | Возвращает `message` (содержит UI рендеринг, но текст заменим)          |
| `exportCommand.ts`   | `export`    | Файловый I/O, возвращает `message`                                      |
| `initCommand.ts`     | `init`      | Возвращает `submit_prompt`/`message`/`confirm_action`                   |
| `memoryCommand.ts`   | `memory`    | Подкоманды возвращают `message` (файловый I/O)                          |
| `planCommand.ts`     | `plan`      | Возвращает `submit_prompt`                                              |
| `summaryCommand.ts`  | `summary`   | Уже имеет адаптацию executionMode, возвращает `submit_prompt`/`message` |
| `insightCommand.ts`  | `insight`   | Возвращает `stream_messages`                                            |

> **Заметка**: `contextCommand` и `insightCommand`, хотя в настоящее время возвращают вызов `addItem`, по сути являются текстовым содержимым, относятся к `local`.

**Класс `local-jsx`** (объявить `commandType: 'local-jsx'`, `supportedModes` выводится как `['interactive']`):

| Файл команды              | Имя команды      | Причина, по которой не может быть headless         |
| ------------------------- | ---------------- | -------------------------------------------------- |
| `aboutCommand.ts`         | `about`          | `addItem(HistoryItemAbout)` — сложный UI-компонент |
| `agentsCommand.ts`        | `agents`         | `dialog: subagent_create/subagent_list`            |
| `approvalModeCommand.ts`  | `approval-mode`  | `dialog: approval-mode`                            |
| `arenaCommand.ts`         | `arena`          | `dialog: arena_*`                                  |
| `authCommand.ts`          | `auth`           | `dialog: auth`                                     |
| `clearCommand.ts`         | `clear`          | `ui.clear()` напрямую оперирует терминалом         |
| `copyCommand.ts`          | `copy`           | Операции буфера обмена, нет пути headless          |
| `directoryCommand.tsx`    | `directory`      | JSX-компонент                                      |
| `docsCommand.ts`          | `docs`           | Открытие браузера                                  |
| `editorCommand.ts`        | `editor`         | `dialog: editor`                                   |
| `extensionsCommand.ts`    | `extensions`     | `dialog: extensions_manage`                        |
| `helpCommand.ts`          | `help`           | `addItem(HistoryItemHelp)` — сложный UI Help       |
| `hooksCommand.ts`         | `hooks`          | `dialog: hooks`                                    |
| `ideCommand.ts`           | `ide`            | Обнаружение и взаимодействие с процессом IDE       |
| `languageCommand.ts`      | `language`       | `dialog` + `reloadCommands`                        |
| `mcpCommand.ts`           | `mcp`            | `dialog: mcp`                                      |
| `modelCommand.ts`         | `model`          | `dialog: model/fast-model`                         |
| `permissionsCommand.ts`   | `permissions`    | `dialog: permissions`                              |
| `quitCommand.ts`          | `quit`           | `quit` тип результата                              |
| `restoreCommand.ts`       | `restore`        | `load_history` тип результата                      |
| `resumeCommand.ts`        | `resume`         | `dialog: resume`                                   |
| `settingsCommand.ts`      | `settings`       | `dialog: settings`                                 |
| `setupGithubCommand.ts`   | `setup-github`   | `confirm_shell_commands` + интерактивные операции  |
| `skillsCommand.ts`        | `skills`         | `addItem(HistoryItemSkillsList)` — сложный UI      |
| `statsCommand.ts`         | `stats`          | `addItem(HistoryItemStats)` — сложный UI           |
| `statuslineCommand.ts`    | `statusline`     | Конфигурация состояния UI                          |
| `terminalSetupCommand.ts` | `terminal-setup` | Мастер настройки терминала                         |
| `themeCommand.ts`         | `theme`          | `dialog: theme`                                    |
| `toolsCommand.ts`         | `tools`          | `addItem(HistoryItemTools)` — сложный UI           |
| `trustCommand.ts`         | `trust`          | `dialog: trust`                                    |
| `vimCommand.ts`           | `vim`            | `toggleVimEnabled()` — состояние UI                |

---

## 5. Правила вывода `getEffectiveSupportedModes`

Эта функция является основной логикой Phase 1, заменяет существующий белый список, будет вызываться `filterCommandsForMode`.

```typescript
/**
 * Получить фактический список поддерживаемых режимов команды.
 *
 * Приоритет вывода (от высокого к низкому):
 * 1. Явно объявленные supportedModes команды (наивысший приоритет)
 * 2. Вывод на основе commandType
 * 3. Резерв на основе CommandKind (обратная совместимость)
 */
export function getEffectiveSupportedModes(cmd: SlashCommand): ExecutionMode[] {
  // Приоритет 1: явное объявление
  if (cmd.supportedModes !== undefined) {
    return cmd.supportedModes;
  }

  // Приоритет 2: вывод на основе commandType
  if (cmd.commandType !== undefined) {
    switch (cmd.commandType) {
      case 'prompt':
        // Команды типа prompt не имеют зависимости от UI, естественно доступны во всех режимах
        return ['interactive', 'non_interactive', 'acp'];
      case 'local':
        // Команды типа local консервативны по умолчанию: только interactive.
        // Команды, нуждающиеся в неинтерактивной поддержке, должны явно объявить supportedModes (соответствует supportsNonInteractive: true в Claude Code).
        // Phase 2 проверять и разблокировать по одной, чтобы предотвратить неожиданное отображение headless-вызывающим команд без адаптации.
        return ['interactive'];
      case 'local-jsx':
        return ['interactive'];
    }
  }

  // Приоритет 3: резерв (на основе CommandKind, обратная совместимость старого кода)
  switch (cmd.kind) {
    case CommandKind.BUILT_IN:
      // built-in команды при отсутствии объявления commandType консервативны по умолчанию (только interactive)
      // Эта ветвь после завершения Phase 1 не должна больше попадаться (все built-in имеют commandType)
      return ['interactive'];
    case CommandKind.FILE:
    case CommandKind.SKILL:
    case CommandKind.MCP_PROMPT:
      // Эти три типа команд action естественно не имеют зависимости от UI, историческое поведение также доступно во всех режимах
      return ['interactive', 'non_interactive', 'acp'];
    default:
      return ['interactive'];
  }
}
```

```typescript
/**
 * Отфильтровать команды, подходящие для текущего режима.
 * Заменить оригинальную функцию filterCommandsForNonInteractive.
 */
export function filterCommandsForMode(
  commands: readonly SlashCommand[],
  mode: ExecutionMode,
): SlashCommand[] {
  return commands.filter((cmd) =>
    getEffectiveSupportedModes(cmd).includes(mode),
  );
}
```

---

## 6. Расширение интерфейса `CommandService`

Добавить два метода в `packages/cli/src/services/CommandService.ts`:

```typescript
export class CommandService {
  // ── Существующие методы (без изменений) ────────────────────────────────────────────────
  getCommands(): readonly SlashCommand[] {
    return this.commands;
  }

  // ── Phase 1 добавленные методы ─────────────────────────────────────────────────

  /**
   * Возвращает список команд, доступных в указанном режиме выполнения.
   * Заменяет комбинацию оригинального белого списка + filterCommandsForNonInteractive.
   *
   * @param mode Целевой режим выполнения
   * @returns Список команд, подходящих для этого режима (без hidden команд)
   */
  getCommandsForMode(mode: ExecutionMode): readonly SlashCommand[] {
    return this.commands.filter((cmd) => {
      if (cmd.hidden) return false;
      return getEffectiveSupportedModes(cmd).includes(mode);
    });
  }

  /**
   * Возвращает все команды с modelInvocable = true.
   * Phase 2 SkillTool будет потреблять этот метод; Phase 1 только предоставляет интерфейс.
   *
   * @returns Список команд, вызываемых моделью
   */
  getModelInvocableCommands(): readonly SlashCommand[] {
    return this.commands.filter(
      (cmd) => !cmd.hidden && cmd.modelInvocable === true,
    );
  }
}
```

> **Заметка**: `getEffectiveSupportedModes` и `filterCommandsForMode` должны использоваться как внутренние инструментальные функции `CommandService` или извлечены в отдельный файл `packages/cli/src/services/commandUtils.ts` и экспортированы для тестирования и повторного использования.

---

## 7. Рефакторинг `nonInteractiveCliCommands.ts`

### 7.1 Удаляемое содержимое

```typescript
// ❌ Удалить
export const ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE = [
  'init', 'summary', 'compress', 'btw', 'bug', 'context',
] as const;

// ❌ Удалить
function filterCommandsForNonInteractive(
  commands: readonly SlashCommand[],
  allowedBuiltinCommandNames: Set<string>,
): SlashCommand[] { ... }
```

### 7.2 Добавляемое содержимое

```typescript
// ✅ Добавить (или импортировать из commandUtils)
import { filterCommandsForMode } from '../services/commandUtils.js';
```

### 7.3 Изменение сигнатуры функции `handleSlashCommand`

```typescript
// ❌ Старая сигнатура
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<NonInteractiveSlashCommandResult>

// ✅ Новая сигнатура (удалить allowedBuiltinCommandNames)
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
): Promise<NonInteractiveSlashCommandResult>
```

### 7.4 Изменение внутренней реализации

```typescript
// Старое:
const filteredCommands = filterCommandsForNonInteractive(
  allCommands,
  allowedBuiltinSet,
);

// Новое:
const executionMode = isAcpMode ? 'acp' : 'non_interactive';
const filteredCommands = filterCommandsForMode(allCommands, executionMode);
```

### 7.5 Изменение сигнатуры функции `getAvailableCommands`

```typescript
// ❌ Старая сигнатура
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<SlashCommand[]>

// ✅ Новая сигнатура
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  mode: ExecutionMode = 'acp',
): Promise<SlashCommand[]>
```

> Новый параметр `mode` заменяет оригинальный параметр белого списка, вызывающий ACP Session может явно указать `'acp'`, вызывающий non-interactive указывает `'non_interactive'`.

---

## 8. Изменение вызова `Session.ts` (ACP)

```typescript
// ❌ Старый вызов
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
  // не передавать, использовать белый список по умолчанию
);

// ✅ Новый вызов (без изменений, удалён несуществующий параметр по умолчанию)
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
);

// ─────────────────────────────────────────

// ❌ Старый вызов
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
);

// ✅ Новый вызов (явно указать mode)
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
  'acp',
);
```

---

## 9. Обзор изменений файлов

### 9.1 Изменённые файлы

| Файл                                                                    | Изменения                                                                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/commands/types.ts`                                 | Добавлены типы `ExecutionMode`, `CommandSource`, `CommandType`; расширен интерфейс `SlashCommand`                                             |
| `packages/cli/src/services/CommandService.ts`                           | Добавлены методы `getCommandsForMode()`, `getModelInvocableCommands()`                                                                        |
| `packages/cli/src/nonInteractiveCliCommands.ts`                         | Удалены константы белого списка и старая функция фильтрации; обновлены сигнатуры двух экспортируемых функций; внедрён `filterCommandsForMode` |
| `packages/cli/src/acp-integration/session/Session.ts`                   | Обновлены вызовы `handleSlashCommand` и `getAvailableCommands`                                                                                |
| `packages/cli/src/services/BuiltinCommandLoader.ts`                     | Внедрены `source: 'builtin-command'`, `sourceLabel: 'Built-in'`, `modelInvocable: false` при построении команд                                |
| `packages/cli/src/services/BundledSkillLoader.ts`                       | Внедрены `source: 'bundled-skill'`, `commandType: 'prompt'`, `modelInvocable: true`                                                           |
| `packages/cli/src/services/FileCommandLoader.ts` / `command-factory.ts` | Внедрены `source`, `commandType: 'prompt'`, `modelInvocable` (по extensionName)                                                               |
| `packages/cli/src/services/McpPromptLoader.ts`                          | Внедрены `source: 'mcp-prompt'`, `commandType: 'prompt'`, `modelInvocable: true`                                                              |
| **Файлы built-in команд (10 local + 27 local-jsx)**                     | Объявлен `commandType: 'local'` или `commandType: 'local-jsx'`                                                                                |

### 9.2 Новые файлы

| Файл                                        | Содержимое                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/cli/src/services/commandUtils.ts` | Инструментальные функции `getEffectiveSupportedModes()`, `filterCommandsForMode()` и их экспорт |

### 9.3 Неизменённые файлы

- `packages/cli/src/utils/commands.ts` (`parseSlashCommand` не требует изменения)
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts` (путь interactive не требует изменения)
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts` (stub UI не требует изменения)
- Все реализации `action` команд (Phase 1 не изменяет поведение любых команд)

---

## 10. Анализ влияния на поведение

### 10.1 Сводка изменений

| Сценарий                                 | Старое поведение                 | Новое поведение                                                       | Свойство             |
| ---------------------------------------- | -------------------------------- | --------------------------------------------------------------------- | -------------------- |
| non-interactive выполнение `/init`       | ✅ разрешено (белый список)      | ✅ разрешено (`commandType: local`)                                   | Без изменений        |
| non-interactive выполнение `/summary`    | ✅ разрешено                     | ✅ разрешено                                                          | Без изменений        |
| non-interactive выполнение `/compress`   | ✅ разрешено                     | ✅ разрешено                                                          | Без изменений        |
| non-interactive выполнение `/btw`        | ✅ разрешено                     | ✅ разрешено                                                          | Без изменений        |
| non-interactive выполнение `/bug`        | ✅ разрешено                     | ✅ разрешено                                                          | Без изменений        |
| non-interactive выполнение `/context`    | ✅ разрешено                     | ✅ разрешено                                                          | Без изменений        |
| non-interactive выполнение `/model`      | ❌ unsupported                   | ❌ unsupported (`commandType: local-jsx`)                             | Без изменений        |
| non-interactive выполнение file command  | ✅ разрешено (CommandKind.FILE)  | ✅ разрешено (`commandType: prompt`)                                  | Без изменений        |
| non-interactive выполнение bundled skill | ✅ разрешено (CommandKind.SKILL) | ✅ разрешено (`commandType: prompt`)                                  | Без изменений        |
| non-interactive выполнение MCP prompt    | ❌ перехвачено CommandKind       | ✅ разрешено (`commandType: prompt`)                                  | **Исправление бага** |
| non-interactive выполнение `/export`     | ❌ не в белом списке             | ❌ не разрешено (`commandType: local`, по умолчанию interactive only) | Без изменений        |
| non-interactive выполнение `/memory`     | ❌ не в белом списке             | ❌ не разрешено (`commandType: local`, по умолчанию interactive only) | Без изменений        |
| non-interactive выполнение `/plan`       | ❌ не в белом списке             | ❌ не разрешено (`commandType: local`, по умолчанию interactive only) | Без изменений        |

> **О консервативной стратегии по умолчанию для команд `local`**: `supportedModes` по умолчанию для `commandType: 'local'` — `['interactive']`, это согласуется с дизайном Claude Code — команды типа `local` требуют явного объявления `supportsNonInteractive: true` для запуска в неинтерактивном режиме. В Phase 1 6 команд в белом списке (`init`, `summary`, `compress`, `btw`, `bug`, `context`) явно объявляют `supportedModes: ['interactive', 'non_interactive', 'acp']` для эквивалентной замены эффекта оригинального белого списка. Команды, требующие расширения в Phase 2 (например, `/export`, `/memory`, `/plan`), после проверки реализации action на headless-friendly, затем разблокируются по одной.

---

## 10.2 Команды режима Phase 2: режим двойной регистрации

Для команд, нуждающихся в "UI в интерактивном режиме, текстовый вывод в неинтерактивном режиме" в Phase 2 (например, `/model`), следует использовать **режим двойной регистрации**, а не ветвление action внутри одной команды.

Это стандартный режим Claude Code, на примере `/context` (см. `src/commands/context/index.ts`): два объекта `Command` с одинаковым именем, один `local-jsx` только interactive, другой `local` только non-interactive, взаимно исключаются через `isEnabled()`.

Nessy CLI в Phase 2 должен использовать эквивалентный способ, используя `supportedModes` вместо `isEnabled()` для взаимного исключения:

```typescript
// ① Версия интерактивного режима: local-jsx, только interactive
export const modelCommandInteractive: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local-jsx',
  supportedModes: ['interactive'], // явное ограничение
  // action: открыть dialog выбора model
};

// ② Версия неинтерактивного/acp: local, явно открыто для headless-вызывающих
export const modelCommandHeadless: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['non_interactive', 'acp'], // явное ограничение
  // action: чтение/установка model, возврат message (чистый текст)
};
```

Два объекта с одинаковым именем, `supportedModes` взаимно исключаются, `filterCommandsForMode` автоматически выбирает правильную версию. По сравнению с взаимным исключением `isEnabled()` в Claude Code, фильтрация `supportedModes` более явная, легче тестируется и не требует обнаружения среды выполнения.

**Phase 1 не реализует никаких команд двойной регистрации**, этот режим зарезервирован здесь только как спецификация реализации для Phase 2.

---

## 11. Стратегия тестирования

### 11.1 Тесты новых инструментальных функций

В `packages/cli/src/services/commandUtils.test.ts` (новый файл):

```typescript
describe('getEffectiveSupportedModes', () => {
  it('явные supportedModes приоритетнее вывода commandType', () => {
    const cmd: SlashCommand = {
      name: 'test', description: '', kind: CommandKind.BUILT_IN,
      commandType: 'local',
      supportedModes: ['interactive'], // явное ограничение
    };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: local выводится как all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('commandType: local-jsx выводится как interactive only', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local-jsx' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: prompt выводится как all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.SKILL, commandType: 'prompt' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('не объявлен commandType и CommandKind.BUILT_IN, резерв interactive', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('не объявлен commandType и CommandKind.FILE, резерв all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.FILE };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('не объявлен commandType и CommandKind.MCP_PROMPT, резерв all modes (исправление оригинального ограничения)', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.MCP_PROMPT };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });
});

describe('filterCommandsForMode', () => {
  it('правильно фильтрует команды в режиме non_interactive', () => { ... });
  it('правильно фильтрует команды в режиме acp', () => { ... });
  it('не фильтрует hidden команды (filterCommandsForMode не обрабатывает hidden, CommandService обрабатывает)', () => { ... });
});
```

### 11.2 Обновление `nonInteractiveCliCommands.test.ts`

- Удалить все ссылки на `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE`
- Удалить тестовые случаи для параметра `allowedBuiltinCommandNames`
- Добавить: проверка прохождения команд commandType: local фильтрации в non-interactive
- Добавить: проверка фильтрации команд commandType: local-jsx в non-interactive
- Сохранить: проверка прохождения file command / skill command фильтрации в non-interactive

### 11.3 Обновление `CommandService.test.ts`

- Добавить тестовые случаи для `getCommandsForMode`
- Добавить тестовые случаи для `getModelInvocableCommands`

### 11.4 Тесты каждого Loader

- `BuiltinCommandLoader.test.ts`: проверка всех команд на `source: 'builtin-command'`
- `BundledSkillLoader.test.ts`: проверка `source: 'bundled-skill'` и `modelInvocable: true`
- `FileCommandLoader.test.ts`: проверка пользовательских команд на `source: 'skill-dir-command'`, команд плагинов на `source: 'plugin-command'`
- `McpPromptLoader.test.ts`: проверка `source: 'mcp-prompt'` и `modelInvocable: true`

---

## 12. Порядок реализации

Рекомендуется реализовывать в следующем порядке, каждый шаг может быть независимо закоммичен и ревьюирован:

**Step 1** (~30 мин): Изменить `types.ts`, добавить `ExecutionMode`, `CommandSource`, `CommandType` и новые поля `SlashCommand`
→ Изменения чистых типов, проверка компиляции TypeScript

**Step 2** (~1 ч): Создать `commandUtils.ts`, реализовать `getEffectiveSupportedModes` и `filterCommandsForMode`, одновременно создать `commandUtils.test.ts`
→ Покрытие модульными тестами основной логики

**Step 3** (~1 ч): Рефакторинг `nonInteractiveCliCommands.ts`, удалить белый список, внедрить `filterCommandsForMode`, обновить сигнатуры функций
→ Эквивалентность поведения (консервативная стратегия Phase 1: команды local явно пишут `supportedModes: ['interactive']`)

**Step 4** (~30 мин): Обновить `CommandService.ts`, добавить два метода

**Step 5** (~2 ч): Добавить объявления `commandType` для всех файлов built-in команд
→ Пошаговое подтверждение правильности классификации

**Step 6** (~1.5 ч): Обновить все Loader, внедрить `source`, `sourceLabel`, `commandType`, `modelInvocable`

**Step 7** (~30 мин): Обновить сигнатуры вызовов в `Session.ts`

**Step 8** (~1 ч): Запустить все тесты, исправить неудачные случаи, обновить снимки

**Step 9** (~30 мин): Самопроверка CR: подтвердить полное удаление белого списка, нет пропущенных вызовов

---

## 13. Контрольный список приёмки

- [ ] Ошибок компиляции TypeScript нет (`npm run typecheck`)
- [ ] Ошибок lint нет (`npm run lint`)
- [ ] Все существующие тесты проходят (`cd packages/cli && npx vitest run`)
- [ ] Все новые тесты `commandUtils.test.ts` проходят
- [ ] `getEffectiveSupportedModes` покрывает все 7 случаев
- [ ] `filterCommandsForMode` покрывает три режима interactive / non_interactive / acp
- [ ] `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` нигде в кодовой базе нет ссылок (проверка `grep`)
- [ ] Функция `filterCommandsForNonInteractive` нигде в кодовой базе нет ссылок
- [ ] Все built-in команды имеют поле `commandType`
- [ ] Все Loader выводят команды с полями `source` и `sourceLabel`
- [ ] `BundledSkillLoader` / `FileCommandLoader` (пользовательские команды) / `McpPromptLoader` выводят команды `modelInvocable: true`
- [ ] `BuiltinCommandLoader` выводит команды `modelInvocable: false`
- [ ] `CommandService.getCommandsForMode('non_interactive')` возвращает эквивалентный набор команд до рефакторинга
- [ ] Команды MCP prompt в режиме non-interactive больше не перехватываются ошибочно
