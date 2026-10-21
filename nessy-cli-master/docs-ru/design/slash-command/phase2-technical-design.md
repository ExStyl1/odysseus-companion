---
title: "Phase 2 Technical Design Document: Capability Expansion (Технический дизайн Phase 2: Расширение возможностей)"
---

# Phase 2 Technical Design Document: Capability Expansion (Технический дизайн Phase 2: Расширение возможностей)

## 1. Цели дизайна и ограничения

### 1.1 Цели

- Расширить `supportedModes` 13 built-in команд до включения `non_interactive` и/или `acp`
- Обеспечить, чтобы каждая расширенная команда в пути ACP/non-interactive возвращала текстовое содержимое, подходящее для потребления IDE
- Реализовать путь вызова модели prompt command (`SkillTool` потребляет `getModelInvocableCommands()`)
- Реализовать базовое обнаружение mid-input slash command

### 1.2 Жёсткие ограничения

- **Нулевая регрессия interactive пути**: все расширенные команды строго сохраняют существующее interactive поведение, только добавляют ветвление режима внутри action, не касаются кода interactive пути
- **Стратегия реализации: ветвление режима, а не двойная регистрация**: 13 команд используют способ добавления определения `executionMode` внутри `action`, не используют режим двойной регистрации, описанный в Phase 1 design document §10.2 (двойная регистрация необходима только когда логика interactive и non-interactive крайне различается, сложность команд этого этапа не достигает этого порога)
- **Формат сообщений ACP**: текст, возвращаемый путём ACP, не содержит ANSI-стилей, предпочтителен Markdown или чистый текст, ориентированный на потребление IDE
- **Пропуск зависимых от окружения побочных эффектов**: операции, зависящие от графического окружения, такие как открытие браузера (`open()`), операции буфера обмена (`copyToClipboard()`), должны быть пропущены в пути non-interactive/ACP

---

## 2. Базовое состояние после завершения Phase 1

Ключевые моменты архитектуры после Phase 1 (Phase 2 напрямую расширяется на этой основе):

- Поле `commandType` удалено из интерфейса `SlashCommand`, все команды используют явные `supportedModes`
- `getEffectiveSupportedModes()` — двухуровневый вывод: явные `supportedModes` → резерв `CommandKind`
- `CommandService.getCommandsForMode(mode)` заменяет оригинальный белый список `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE`
- `btw`, `bug`, `compress`, `context`, `init`, `summary` уже расширены до всех режимов в Phase 1, **не в списке этого этапа**
- `createNonInteractiveUI()` все методы являются no-op: `addItem`, `clear`, `setDebugMessage`, `setPendingItem`, `reloadCommands` молчаливо игнорируют вызовы

---

## 3. Обзор области изменений

Этот этап затрагивает 13 команд, разделённых на 4 категории по сложности реализации:

| Категория              | Команды                                      | Ключевые моменты изменений                                                                                                          |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **A класс**            | `export`                                     | Только изменить `supportedModes`, action все пути уже возвращают легальный тип                                                      |
| **Только interactive** | `plan`, `statusline`                         | Решение дизайна: эти команды семантически тесно связаны с интерфейсом, сохранить `supportedModes: ['interactive']`                  |
| **A+ класс**           | `language`                                   | Изменить `supportedModes` + небольшая обработка ветви non-interactive                                                               |
| **Только interactive** | `copy`, `restore`                            | Решение дизайна: буфер обмена и восстановление снимков по сути интерактивные операции, сохранить `supportedModes: ['interactive']`  |
| **A' класс**           | `model`, `approval-mode`                     | Путь с аргументами уже возвращает `message`, путь без аргументов требует добавления ветви non-interactive (сейчас запускает dialog) |
| **B класс**            | `about`, `stats`, `insight`, `docs`, `clear` | action все пути не имеют возвращаемого значения или вызывают `addItem`/`clear`, требуют добавления полной ветви non-interactive     |

---

## 4. A класс: только изменение `supportedModes`

Три команды всех путей `action` уже возвращают `message` или `submit_prompt`, полностью без зависимости от UI, `handleCommandResult` может напрямую обработать.

### 4.1 `/export` (и подкоманды)

**Текущее состояние**: `supportedModes: ['interactive']`, все подкоманды action возвращают `MessageActionReturn`.

**Изменение**: изменить `supportedModes` родительской команды и всех четырёх подкоманд (`md`, `html`, `json`, `jsonl`) на `['interactive', 'non_interactive', 'acp']`.

**Содержимое сообщений ACP**: существующее возвращаемое содержимое action уже содержит полный путь к файлу (например, `Session exported to markdown: nessy-export-2024-01-01T12-00-00.md`), дружественно к потреблению IDE, не требует изменения текста.

> **Заметка**: у родительской команды `/export` нет `action`, только подкоманды. После изменения `supportedModes` родительской команды на все режимы, `parseSlashCommand` сможет сопоставить маршрут подкоманды, но если пользователь введёт только `/export` без подкоманды, `commandToExecute.action` будет undefined, `handleSlashCommand` вернёт `no_command`, вызывающая сторона отобразит подсказку доступных подкоманд. Это ожидаемое поведение.

### 4.2 `/plan`

**Текущее состояние**: `supportedModes: ['interactive']`, action все пути возвращают `MessageActionReturn` или `SubmitPromptActionReturn`.

**Решение дизайна**: `/plan` — команда, ведущая пользователя к многоходовому интерактивному планированию, семантически тесно связана с интерфейсом. После обсуждения решено сохранить `supportedModes: ['interactive']`, не расширять до режимов non-interactive/acp.

### 4.3 `/statusline`

**Текущее состояние**: `supportedModes: ['interactive']`, action всегда возвращает `SubmitPromptActionReturn` (отправляет prompt вызова subagent модели).

**Решение дизайна**: `/statusline` — команда запуска subagent для резюме текущего состояния, семантически тесно связана с интерфейсом. После обсуждения решено сохранить `supportedModes: ['interactive']`, не расширять до режимов non-interactive/acp.

---

## 5. A+ класс: небольшая обработка ветви non-interactive

### 5.1 `/language`

**Текущее состояние**: action все пути возвращают `MessageActionReturn` (чтение/установка настроек языка).

**Побочные эффекты, требующие обработки**: `setUiLanguage()` внутри вызывает `context.ui.reloadCommands()`, в неинтерактивном UI уже no-op, не требует дополнительной обработки.

**Изменение**:

- Изменить `supportedModes` родительской команды и подкоманд (`ui`, `output`, а также динамически сгенерированных подкоманд `SUPPORTED_LANGUAGES`) на `['interactive', 'non_interactive', 'acp']`.
- action не требует добавления ветвления режима, существующий возвращаемый текст уже подходит для потребления машиной.

**Описание семантики ACP**: выполнение `/language ui zh-CN` в non-interactive (одноразовый вызов) изменяет персистентные настройки (запись в файл settings), это изменение действует для последующих session, i18n внутри текущей session также немедленно действует. Это согласуется с ожиданиями пользователя.

### 5.2 `/copy`

**Текущее состояние**: action вызывает `copyToClipboard()`, в окружении ACP/headless может выбросить исключение или молчаливо завершиться неудачей (clipboard недоступен).

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Добавить ветвь режима внутри action:

```typescript
// Получить последнее AI сообщение (существующая логика, можно переиспользовать)
if (context.executionMode !== 'interactive') {
  // non-interactive/ACP: пропустить буфер обмена, вернуть само содержимое
  if (!lastAiOutput) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No output in history.',
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: lastAiOutput,
  };
}
// interactive путь: существующая логика буфера обмена без изменений
await copyToClipboard(lastAiOutput);
return {
  type: 'message',
  messageType: 'info',
  content: 'Last output copied to the clipboard',
};
```

**Семантика ACP**: IDE получает оригинальный текст последнего вывода модели, может самостоятельно решить, записывать ли в буфер обмена или отображать пользователю.

### 5.3 `/restore`

**Текущее состояние**: `supportedModes: ['interactive']`.

**Решение дизайна**: восстановление снимка далее будет повторно выполнять вызовы инструментов, семантически тесно связано с интерфейсом. После обсуждения решено сохранить `supportedModes: ['interactive']`, не расширять до режимов non-interactive/acp.

**Семантика ACP**: восстановление состояния git checkpoint и установка gemini client history выполняются как побочные эффекты; IDE после получения подтверждающего сообщения может подсказать пользователю "состояние восстановлено", повторное выполнение инструментов решается IDE самостоятельно.

---

## 6. A' класс: обработка пути dialog без аргументов в non-interactive

### 6.1 `/model`

**Текущее состояние**:

| Ввод                             | Текущее поведение                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `/model` (без аргументов)        | → `{ type: 'dialog', dialog: 'model' }` (в non-interactive становится unsupported)      |
| `/model <model-id>`              | Не реализовано (только ветвь `--fast`)                                                  |
| `/model --fast` (без model name) | → `{ type: 'dialog', dialog: 'fast-model' }` (в non-interactive становится unsupported) |
| `/model --fast <model-id>`       | → `MessageActionReturn` ✅                                                              |

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Вставить ветвь non-interactive перед каждым путем dialog в action:

```typescript
// Путь без аргументов (оригинально возвращает dialog: 'model')
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentModel = config.getModel() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current model: ${currentModel}\nUse "/model <model-id>" to switch models.`,
    };
  }
  return { type: 'dialog', dialog: 'model' };
}

// Путь --fast без аргументов (оригинально возвращает dialog: 'fast-model')
if (args.startsWith('--fast') && !modelName) {
  if (context.executionMode !== 'interactive') {
    const fastModel = context.services.settings?.merged?.fastModel ?? 'not set';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current fast model: ${fastModel}\nUse "/model --fast <model-id>" to set fast model.`,
    };
  }
  return { type: 'dialog', dialog: 'fast-model' };
}
```

**Семантика ACP**: IDE отображает имя текущей модели для справки пользователя; переключение модели реализуется через вызов с аргументом (`/model <model-id>`).

> **Заметка**: `/model <model-id>` (без `--fast`) в настоящее время не имеет логики установки модели текущей session, только `--fast <model-id>` имеет. Если Phase 2 должен поддерживать переключение главной модели в ACP, нужно синхронно реализовать логику set `/model <model-id>`. Этот дизайн резервирует этот путь, но помечает как опцию Phase 2, приоритетно гарантируя путь read-only "просмотр текущей модели".

### 6.2 `/approval-mode`

**Текущее состояние**:

| Ввод                        | Текущее поведение                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `/approval-mode` (без арг.) | → `{ type: 'dialog', dialog: 'approval-mode' }` (в non-interactive становится unsupported) |
| `/approval-mode <mode>`     | → `MessageActionReturn` ✅                                                                 |
| `/approval-mode <invalid>`  | → `MessageActionReturn` (error) ✅                                                         |

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Вставить ветвь non-interactive в путь без аргументов (`!args.trim()`):

```typescript
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentMode = config?.getApprovalMode() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current approval mode: ${currentMode}\nAvailable modes: ${APPROVAL_MODES.join(', ')}\nUse "/approval-mode <mode>" to change.`,
    };
  }
  return { type: 'dialog', dialog: 'approval-mode' };
}
```

---

## 7. B класс: требует полной ветви non-interactive

Пять команд action в interactive режиме рендерят React-компоненты через `context.ui.addItem()` или вызывают `context.ui.clear()`, возвращаемое значение — `void`. В non-interactive эти вызовы являются no-op, что приводит к обработке `handleSlashCommand` отсутствия возвращаемого значения как `"Command executed successfully."`, без фактического вывода содержимого.

**Принцип реализации**: в **верхней части** action проверить `executionMode`, при не interactive **досрочно вернуть** `message` с фактическим содержимым, код interactive пути полностью не затрагивается.

### 7.1 `/about` (altName: `status`)

**Источник данных**: `getExtendedSystemInfo(context)` возвращает `ExtendedSystemInfo`, содержит: `cliVersion`, `osPlatform`, `osArch`, `osRelease`, `nodeVersion`, `modelVersion`, `selectedAuthType`, `ideClient`, `sessionId`, `memoryUsage`, `baseUrl`, `apiKeyEnvKey`, `gitCommit`, `fastModel`. Все поля доступны в non-interactive (context.services.config и settings уже внедрены).

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. После вызова `getExtendedSystemInfo`, перед interactive путем вставить ветвь режима:

```typescript
action: async (context) => {
  const systemInfo = await getExtendedSystemInfo(context);

  if (context.executionMode !== 'interactive') {
    const lines = [
      `Nessy CLI v${systemInfo.cliVersion}`,
      `Model: ${systemInfo.modelVersion}`,
      `Fast Model: ${systemInfo.fastModel ?? 'not set'}`,
      `Auth: ${systemInfo.selectedAuthType}`,
      `Platform: ${systemInfo.osPlatform} ${systemInfo.osArch} (${systemInfo.osRelease})`,
      `Node.js: ${systemInfo.nodeVersion}`,
      `Session: ${systemInfo.sessionId}`,
      ...(systemInfo.gitCommit ? [`Git commit: ${systemInfo.gitCommit}`] : []),
      ...(systemInfo.ideClient ? [`IDE: ${systemInfo.ideClient}`] : []),
    ];
    return {
      type: 'message',
      messageType: 'info',
      content: lines.join('\n'),
    };
  }

  // interactive путь: существующая логика addItem без изменений
  const aboutItem: Omit<HistoryItemAbout, 'id'> = { type: MessageType.ABOUT, systemInfo };
  context.ui.addItem(aboutItem, Date.now());
},
```

### 7.2 `/stats` (и подкоманды `model`, `tools`)

**Источник данных**: `context.session.stats` (`SessionStatsState`) содержит `sessionStartTime`, `metrics` (`SessionMetrics`: `models`, `tools`, `files`), `promptCount`. В non-interactive `sessionStartTime` — время текущего вызова, `metrics` из `uiTelemetryService.getMetrics()` (накопленное значение текущего вызова, обычно ноль), `promptCount` = 1.

**Изменение**:

1. Изменить `supportedModes` родительской команды `stats` и подкоманд `model`, `tools` на `['interactive', 'non_interactive', 'acp']`.
2. action родительской команды и каждой подкоманды вставить ветвь режима, досрочно вернуть текстовый формат статистики:

```typescript
// Команда /stats
action: (context) => {
  if (context.executionMode !== 'interactive') {
    const now = new Date();
    const { sessionStartTime, promptCount, metrics } = context.session.stats;
    if (!sessionStartTime) {
      return { type: 'message', messageType: 'error', content: 'Session start time unavailable.' };
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    // Суммировать токены всех model
    let totalPromptTokens = 0, totalCandidateTokens = 0, totalRequests = 0;
    for (const modelMetrics of Object.values(metrics.models)) {
      totalPromptTokens += modelMetrics.tokens.prompt;
      totalCandidateTokens += modelMetrics.tokens.candidates;
      totalRequests += modelMetrics.api.totalRequests;
    }

    const lines = [
      `Session duration: ${formatDuration(wallDuration)}`,
      `Prompts: ${promptCount}`,
      `API requests: ${totalRequests}`,
      `Tokens — prompt: ${totalPromptTokens}, output: ${totalCandidateTokens}`,
      `Tool calls: ${metrics.tools.totalCalls} (${metrics.tools.totalSuccess} ok, ${metrics.tools.totalFail} fail)`,
      `Files: +${metrics.files.totalLinesAdded} / -${metrics.files.totalLinesRemoved} lines`,
    ];
    return { type: 'message', messageType: 'info', content: lines.join('\n') };
  }

  // interactive путь: существующая логика addItem без изменений
  const statsItem: HistoryItemStats = { type: MessageType.STATS, duration: formatDuration(wallDuration) };
  context.ui.addItem(statsItem, Date.now());
},
```

Подкоманды `model` и `tools` также вставляют ветвь режима, возвращают текстовую статистику соответствующего измерения (измерение model перечисляет потребление токенов по имени model; измерение tools перечисляет количество вызовов каждого tool).

**Описание**: в одноразовом вызове non-interactive metrics обычно равны нулю (новая session), но структура полна, не влияет на формат. В ACP Session могут быть накопленные значения, имеют фактическое значение.

### 7.3 `/insight`

**Текущее состояние**: action возвращает `void`, отображает прогресс и результат через `addItem`, наконец вызывает `open(outputPath)` для открытия браузера. Основная логика — `insightGenerator.generateStaticInsight()` генерирует HTML-файл.

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Разветвить по `executionMode` тремя путями:
   - `non_interactive`: синхронная генерация, игнорировать обратный вызов прогресса, не открывать браузер, напрямую вернуть `message` (путь к файлу)
   - `acp`: асинхронный запуск генерации, через `stream_messages` отправить прогресс (`encodeInsightProgressMessage`) и завершение (`encodeInsightReadyMessage`) IDE
   - `interactive`: существующая логика `addItem` + `setPendingItem` + `open()` без изменений

```typescript
// non_interactive путь
if (context.executionMode === 'non_interactive') {
  const outputPath = await insightGenerator.generateStaticInsight(
    projectsDir,
    () => {}, // no-op progress
  );
  return {
    type: 'message',
    messageType: 'info',
    content: t('Insight report generated at: {{path}}', { path: outputPath }),
  };
}

// acp путь: stream_messages
if (context.executionMode === 'acp') {
  // ... сконструировать async generator streamMessages, yield encodeInsightProgressMessage / encodeInsightReadyMessage ...
  return { type: 'stream_messages', messages: streamMessages() };
}

// interactive путь: существующая реализация без изменений
```

**Обоснование дизайна**: режим `non_interactive` (CLI pipeline) не поддерживает `stream_messages`, может вернуть только одну `message`; режим ACP (IDE плагин) может потреблять `stream_messages` и отображать прогресс в реальном времени, поэтому сохраняет путь streaming.

**Формат сообщений ACP**: `encodeInsightProgressMessage(stage, progress, detail?)` генерирует сообщение о прогрессе, которое IDE может разобрать; `encodeInsightReadyMessage(outputPath)` уведомляет IDE о готовности файла, IDE решает, как отображать ссылку.

### 7.4 `/docs`

**Текущее состояние**: action возвращает `void`, отображает сообщение через `addItem` и вызывает `open(docsUrl)` для открытия браузера. Есть ветвь переменной окружения `SANDBOX` (в песочнице только addItem, не открывать браузер).

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Изменить тип возвращаемого значения action на `Promise<void | MessageActionReturn>`.
3. В начале action вставить ветвь non-interactive:

```typescript
action: async (context) => {
  const langPath = getCurrentLanguage()?.startsWith('zh') ? 'zh' : 'en';
  const docsUrl = `https://nessylm.github.io/nessy-cli-docs/${langPath}`;

  if (context.executionMode !== 'interactive') {
    // non-interactive/ACP: напрямую вернуть URL, не открывать браузер, не вызывать addItem
    return {
      type: 'message',
      messageType: 'info',
      content: `Nessy CLI documentation: ${docsUrl}`,
    };
  }

  // interactive путь: существующая проверка SANDBOX + addItem + open() без изменений
  if (process.env['SANDBOX'] && ...) {
    context.ui.addItem(...);
  } else {
    context.ui.addItem(...);
    await open(docsUrl);
  }
},
```

### 7.5 `/clear` (altNames: `reset`, `new`)

**Текущее состояние**: action выполняет следующие операции и возвращает `void`:

1. `config.getHookSystem()?.fireSessionEndEvent()` — запуск hook (с побочными эффектами)
2. `config.startNewSession()` — начало нового session ID (с побочными эффектами)
3. `uiTelemetryService.reset()` — сброс счётчиков telemetry (с побочными эффектами)
4. `skillTool.clearLoadedSkills()` — очистка кэша skill (с побочными эффектами)
5. `context.ui.clear()` — очистка UI терминала (**UI побочный эффект, в non-interactive no-op**)
6. `geminiClient.resetChat()` — сброс истории chat (с побочными эффектами)
7. `config.getHookSystem()?.fireSessionStartEvent()` — запуск hook (с побочными эффектами)

**Анализ семантики non-interactive/ACP**:

- `ui.clear()` в non-interactive уже no-op, не требует обработки
- `geminiClient.resetChat()`: в ACP Session имеет смысл (очистка истории chat), следует сохранить; в одноразовом вызове non-interactive каждый вызов — новая session, `resetChat` семантически избыточен, но безвреден
- `config.startNewSession()`: в ACP имеет смысл (начало нового session ID); в одноразовом вызове non-interactive аналогично семантически избыточен, но безвреден
- `fireSessionEndEvent` / `fireSessionStartEvent`: в ACP имеет смысл (запуск hook)

**Решение**: путь non-interactive/ACP сохраняет все имеющие смысл побочные эффекты (resetChat, startNewSession, hook events), только пропускает `ui.clear()` (уже no-op) и возвращает message с маркером границы контекста.

**Изменение**:

1. Изменить `supportedModes` на `['interactive', 'non_interactive', 'acp']`.
2. Изменить тип возвращаемого значения action на `Promise<void | MessageActionReturn>`.
3. Внутри action, после вызова `context.ui.clear()` (или вместо него) в зависимости от режима:

```typescript
action: async (context, _args) => {
  const { config } = context.services;

  if (config) {
    config.getHookSystem()?.fireSessionEndEvent(SessionEndReason.Clear).catch(...);

    const newSessionId = config.startNewSession();
    uiTelemetryService.reset();

    const skillTool = config.getToolRegistry()?.getAllTools().find(...);
    if (skillTool instanceof SkillTool) skillTool.clearLoadedSkills();

    if (newSessionId && context.session.startNewSession) {
      context.session.startNewSession(newSessionId);
    }

    // ui.clear() в non-interactive уже no-op, но всё равно вызывается (не требует условной ветви)
    context.ui.clear();

    const geminiClient = config.getGeminiClient();
    if (geminiClient) {
      await geminiClient.resetChat();
    }

    config.getHookSystem()?.fireSessionStartEvent(...).catch(...);
  } else {
    context.ui.clear();
  }

  // Определить возвращаемое значение в зависимости от режима
  if (context.executionMode !== 'interactive') {
    return {
      type: 'message',
      messageType: 'info',
      content: 'Context cleared. Previous messages are no longer in context.',
    };
  }
  // interactive путь: void (не возвращает, React UI управляется обновлением ui.clear())
},
```

**Семантика ACP**: IDE после получения маркера границы контекста может отобразить его как разделитель session (например, подсказка "начало новой сессии") и очистить локальный кэш истории chat.

---

## 8. Изменения `handleCommandResult`

**Вывод: не требует изменения.**

После всех изменений команд Phase 2, типы возвращаемых значений пути non-interactive/ACP — `message` или `submit_prompt`, все правильно обработаны в switch `handleCommandResult`.

---

## 9. Изменения `createNonInteractiveUI()`

**Вывод: не требует изменения.**

Текущая реализация no-op уже достаточна. `addItem`, `clear`, `setPendingItem` и т.д. no-op не будут вызваны в пути non-interactive команд B класса (потому что досрочный return); interactive путь не затрагивается.

---

## 10. Phase 2.2: Реализация вызова модели prompt command

В Phase 1 `CommandService.getModelInvocableCommands()` уже реализован, `BundledSkillLoader`, `FileCommandLoader` (пользователь/проект команды), `McpPromptLoader` уже установлены `modelInvocable: true`.

Работа Phase 2.2 — изменить `SkillTool` с потребления только `SkillManager.listSkills()` на одновременное потребление `CommandService.getModelInvocableCommands()`, унифицировать вход вызываемых моделью команд.

**Файл изменения**: `packages/core/src/tools/SkillTool.ts` (или соответствующий путь)

**Конкретные изменения**:

1. `SkillTool` при инициализации получает `CommandService` (или результат его `getModelInvocableCommands()`) как внедрение зависимости
2. При построении description tool объединить результаты `listSkills()` и `getModelInvocableCommands()`
3. Обеспечить, чтобы built-in commands (`modelInvocable: false`) не появлялись в description tool

> **Заметка**: конкретная реализация `SkillTool` зависит от внутренней архитектуры `packages/core`, детальный дизайн в этом документе описывает только изменение интерфейса, детали реализации нужно определять в сочетании с существующей структурой core пакета.

---

## 11. Phase 2.3: Обнаружение mid-input slash command (базовая версия)

В компоненте `InputPrompt` обнаружить slash token рядом с курсором (не только в начале строки), запустить меню автозаполнения.

**Правила обнаружения**:

- Когда перед курсором существует token, начинающийся с `/`, не содержащий пробелов, запустить автозаполнение команд
- Кандидаты автозаполнения из видимого списка команд `getCommandsForMode('interactive')`
- Меню автозаполнения отображает имя команды + description (без argumentHint и т.д., Phase 3 дополняет)

> Эта функция — изменение UI слоя, принадлежит независимой подзадаче Phase 2.3, не влияет на реализацию других Phase 2.1/2.2.

---

## 12. Обзор изменений файлов

### 12.1 Изменения файлов команд (Phase 2.1)

| Файл                     | Тип изменения      | Конкретное содержимое                                                                                                                                                           |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exportCommand.ts`       | A класс            | Родительская команда + 4 подкоманды: `supportedModes` → all modes                                                                                                               |
| `planCommand.ts`         | Только interactive | Решение дизайна: сохранить `supportedModes: ['interactive']`, без изменений                                                                                                     |
| `statuslineCommand.ts`   | Только interactive | Решение дизайна: сохранить `supportedModes: ['interactive']`, без изменений                                                                                                     |
| `languageCommand.ts`     | A+ класс           | Родительская команда + подкоманды `ui`/`output` + динамические language подкоманды: `supportedModes` → all modes                                                                |
| `copyCommand.ts`         | Только interactive | Решение дизайна: сохранить `supportedModes: ['interactive']`, без изменений                                                                                                     |
| `restoreCommand.ts`      | Только interactive | Решение дизайна: сохранить `supportedModes: ['interactive']`, без изменений                                                                                                     |
| `modelCommand.ts`        | A' класс           | `supportedModes` → all modes + путь без аргументов/без fast model добавляет ветвь non-interactive                                                                               |
| `approvalModeCommand.ts` | A' класс           | `supportedModes` → all modes + путь без аргументов добавляет ветвь non-interactive                                                                                              |
| `aboutCommand.ts`        | B класс            | `supportedModes` → all modes + путь non-interactive возвращает `message` (резюме версии/модели/окружения)                                                                       |
| `statsCommand.ts`        | B класс            | `supportedModes` → all modes + путь non-interactive возвращает `message` (текст stats); подкоманды синхронно обрабатываются                                                     |
| `insightCommand.ts`      | B класс            | `supportedModes` → all modes + путь `non_interactive` синхронно генерирует и возвращает `message` (путь к файлу); путь `acp` возвращает `stream_messages` с отправкой прогресса |
| `docsCommand.ts`         | B класс            | `supportedModes` → all modes + путь non-interactive возвращает `message` (URL документации), не открывает браузер                                                               |
| `clearCommand.ts`        | B класс            | `supportedModes` → all modes + action в конце возвращает `message` или `void` в зависимости от режима                                                                           |

### 12.2 Изменения других файлов

| Файл                                                                | Изменения                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/core/src/tools/SkillTool.ts`                              | Phase 2.2: подключение `getModelInvocableCommands()` (детальный дизайн будет определён отдельно) |
| `packages/cli/src/ui/InputPrompt.tsx` (или эквивалентный компонент) | Phase 2.3: логика обнаружения mid-input slash                                                    |

### 12.3 Неизменённые файлы

- `packages/cli/src/nonInteractiveCliCommands.ts` (`handleCommandResult`, `handleSlashCommand` не требуют изменения)
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts` (stub UI не требует изменения)
- `packages/cli/src/services/commandUtils.ts` (`filterCommandsForMode`, `getEffectiveSupportedModes` не требуют изменения)
- `packages/cli/src/services/CommandService.ts` (`getCommandsForMode`, `getModelInvocableCommands` уже реализованы в Phase 1)

---

## 13. Стратегия тестирования

### 13.1 Модульные тесты команд

Для каждой изменённой команды добавить или обновить тестовый файл в том же каталоге (`*.test.ts`), покрыть следующие case:

**Команды A/A+ класса** (`export`, `language`):

- `supportedModes` правильно включает `non_interactive` и `acp`
- В `executionMode: 'non_interactive'` action возвращает `MessageActionReturn` или `SubmitPromptActionReturn`, не вызывает `ui.addItem` или `ui.clear`
- Interactive путь поведения полностью согласован с до рефакторинга (snapshot testing)

**Только interactive команды** (`plan`, `statusline`, `copy`, `restore`):

- `supportedModes` — `['interactive']`, это решение дизайна
- Проверить, что при выполнении в non-interactive правильно возвращается `unsupported`

**Команды A' класса** (`model`, `approval-mode`):

- Без аргументов + `executionMode: 'non_interactive'` → возвращает `message` текущего состояния, не возвращает `dialog`
- С аргументами + `executionMode: 'non_interactive'` → оригинальная логика `message` нормально выполняется
- Interactive путь: без аргументов → `dialog`, с аргументами → `message` (без изменений)

**Команды B класса** (`about`, `stats`, `insight`, `docs`, `clear`):

- В `executionMode: 'non_interactive'` action возвращает `MessageActionReturn`, не вызывает никаких методов `ui.*`
- Возвращаемая строка `content` содержит ожидаемые ключевые поля (номер версии, имя модели, URL и т.д.)
- Interactive путь: вызывается `ui.addItem`, `action` возвращает `void` (без изменений)

**Специальный case `clear`**:

- В `executionMode: 'non_interactive'` `geminiClient.resetChat()` всё ещё вызывается (побочный эффект сохраняется)
- Возвращается пограничное `message` контекста, содержимое — `'Context cleared. Previous messages are no longer in context.'`

### 13.2 Интеграционные тесты (`handleSlashCommand`)

В `nonInteractiveCli.test.ts` или новом интеграционном тестовом файле:

- `handleSlashCommand('/about', ...)` в режиме non-interactive возвращает `{ type: 'message', content: содержит номер версии }`
- `handleSlashCommand('/stats', ...)` в режиме non-interactive возвращает `{ type: 'message', content: содержит 'Session duration' }`
- `handleSlashCommand('/docs', ...)` в режиме non-interactive возвращает `{ type: 'message', content: содержит 'nessylm.github.io' }`
- `handleSlashCommand('/clear', ...)` в режиме non-interactive возвращает `{ type: 'message', content: 'Context cleared.' }`
- `handleSlashCommand('/plan', ...)` в режиме non-interactive возвращает `unsupported` (только interactive команда)
- Существующие команды non-interactive (`btw`, `bug` и т.д.) поведение без регрессии

### 13.3 Тесты `commandUtils`

В `commandUtils.test.ts` добавить (или существующие тесты продолжают покрывать):

- Расширенные команды (`export`, `language` и т.д.) могут пройти фильтрацию `filterCommandsForMode(commands, 'non_interactive')` и `filterCommandsForMode(commands, 'acp')`
- Только interactive команды (`plan`, `statusline`, `copy`, `restore`) правильно отфильтровываются в `filterCommandsForMode(commands, 'non_interactive')`

---

## 14. Анализ влияния на поведение

| Сценарий                                              | Поведение до Phase 2                                                       | Поведение после Phase 2                                 | Свойство                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| non-interactive выполнение `/export md`               | ❌ unsupported (отфильтровано)                                             | ✅ возвращает message с путём к файлу                   | Расширение возможностей                    |
| non-interactive выполнение `/plan <task>`             | ❌ unsupported                                                             | ❌ unsupported (решение дизайна: только interactive)    | Без изменений                              |
| non-interactive выполнение `/statusline`              | ❌ unsupported                                                             | ❌ unsupported (решение дизайна: только interactive)    | Без изменений                              |
| non-interactive выполнение `/language ui zh-CN`       | ❌ unsupported                                                             | ✅ установка языка, возвращает подтверждающее message   | Расширение возможностей                    |
| non-interactive выполнение `/copy`                    | ❌ unsupported                                                             | ❌ unsupported (решение дизайна: только interactive)    | Без изменений                              |
| non-interactive выполнение `/restore` (без арг.)      | ❌ unsupported                                                             | ❌ unsupported (решение дизайна: только interactive)    | Без изменений                              |
| non-interactive выполнение `/restore <id>`            | ❌ unsupported                                                             | ❌ unsupported (решение дизайна: только interactive)    | Без изменений                              |
| non-interactive выполнение `/model`                   | ❌ unsupported (dialog)                                                    | ✅ возвращает имя текущей модели                        | Расширение возможностей                    |
| non-interactive выполнение `/model <id>`              | ❌ unsupported                                                             | 🔄 Phase 2 опционально: реализовать логику переключения | Расширение возможностей (опционально)      |
| non-interactive выполнение `/approval-mode`           | ❌ unsupported (dialog)                                                    | ✅ возвращает текущий режим                             | Расширение возможностей                    |
| non-interactive выполнение `/approval-mode auto-edit` | ❌ unsupported                                                             | ✅ установка режима, возвращает подтверждение           | Расширение возможностей                    |
| non-interactive выполнение `/about`                   | ❌ возвращает "Command executed successfully." (addItem no-op)             | ✅ возвращает резюме версии/модели/окружения            | Исправление бага + расширение возможностей |
| non-interactive выполнение `/stats`                   | ❌ возвращает "Command executed successfully."                             | ✅ возвращает текст статистики session                  | Исправление бага + расширение возможностей |
| non-interactive выполнение `/insight`                 | ❌ возвращает "Command executed successfully." (генерирует, но без вывода) | ✅ генерирует и возвращает путь к файлу                 | Исправление бага + расширение возможностей |
| non-interactive выполнение `/docs`                    | ❌ возвращает "Command executed successfully."                             | ✅ возвращает URL документации                          | Исправление бага + расширение возможностей |
| non-interactive выполнение `/clear`                   | ❌ возвращает "Command executed successfully."                             | ✅ возвращает пограничное message контекста             | Исправление бага + расширение возможностей |
| interactive выполнение любых вышеуказанных команд     | ✅ оригинальное поведение                                                  | ✅ оригинальное поведение (нулевая регрессия)           | Без изменений                              |

---

## 15. Порядок реализации

Рекомендуется реализовывать в следующем порядке, каждая группа может быть независимо закоммичена и ревьюирована:

**Batch 1** (~30 мин): A класс — только изменить `supportedModes`

Изменить `exportCommand.ts` (и его подкоманды), проверить прохождение тестов.

**Batch 2** (~45 мин): A+ класс — небольшая ветвь

Изменить `languageCommand.ts`, добавить ветвь non-interactive для путей с побочными эффектами, обновить соответствующие тесты. (`copyCommand.ts` и `restoreCommand.ts` после обсуждения сохраняются только interactive.)

**Batch 3** (~45 мин): A' класс — путь dialog

Изменить `modelCommand.ts`, `approvalModeCommand.ts`, добавить ветвь non-interactive для путей без аргументов, обновить соответствующие тесты.

**Batch 4** (~1.5 ч): B класс — полная ветвь

Изменить `aboutCommand.ts`, `statsCommand.ts` (включая подкоманды), `docsCommand.ts`.

**Batch 5** (~1 ч): B класс специальный — `insightCommand.ts`, `clearCommand.ts`

Эти две команды имеют много побочных эффектов, отдельный commit, обновить соответствующие тесты и интеграционные тесты.

**Batch 6** (~2 ч): Phase 2.2 — Реализация вызова модели prompt command

Изменить `SkillTool`, подключить `getModelInvocableCommands()`, обновить тесты SkillTool.

**Batch 7** (~2 ч): Phase 2.3 — обнаружение mid-input slash

Изменить компонент `InputPrompt`, добавить новую логику запуска автозаполнения и UI тесты.

**Batch 8** (~30 мин): Полное тестирование + проверка типов

Запустить `npm run typecheck`, `cd packages/cli && npx vitest run`, исправить оставшиеся проблемы.

---

## 16. Контрольный список приёмки

**Phase 2.1 Расширение команд**

- [ ] A класс: `/export` (и подкоманды), `/plan`, `/statusline` могут нормально выполняться в режимах non-interactive и acp и возвращать осмысленный вывод
- [ ] A+ класс: `/language` (и подкоманды) нормально выполняются в non-interactive, установка персистентна
- [ ] A+ класс: `/copy` в non-interactive/acp возвращает текст последнего AI вывода (не оперирует буфером обмена)
- [ ] A+ класс: `/restore` без аргументов в non-interactive возвращает список checkpoint; с аргументами восстанавливает состояние и возвращает подтверждающее message (не возвращает `type: 'tool'`)
- [ ] A' класс: `/model` без аргументов в non-interactive/acp возвращает имя текущей модели (не запускает dialog); `/model --fast <id>` нормально устанавливает
- [ ] A' класс: `/approval-mode` без аргументов в non-interactive/acp возвращает текущий режим (не запускает dialog); с аргументами нормально устанавливает
- [ ] B класс: `/about` в non-interactive/acp возвращает текстовое резюме, содержащее номер версии, имя модели
- [ ] B класс: `/stats` (включая подкоманды) в non-interactive/acp возвращает текстовую статистику
- [ ] B класс: `/insight` в non-interactive/acp генерирует файл insight и возвращает путь к файлу (не открывает браузер)
- [ ] B класс: `/docs` в non-interactive/acp возвращает URL документации (не открывает браузер)
- [ ] B класс: `/clear` в non-interactive/acp возвращает пограничное message контекста, `geminiClient.resetChat()` нормально выполняется
- [ ] Все 13 команд в режиме interactive ведут себя полностью согласованно с до рефакторинга (нет регрессии)
- [ ] Ошибок компиляции TypeScript нет (`npm run typecheck`)
- [ ] Ошибок lint нет (`npm run lint`)
- [ ] Все существующие тесты проходят (`cd packages/cli && npx vitest run`)

**Phase 2.2 Вызов модели**

- [ ] Модель может вызывать bundled skill, file command (пользователь/проект), MCP prompt через `SkillTool`
- [ ] Модель не может вызывать built-in commands
- [ ] tool description `SkillTool` содержит имя и description всех команд `modelInvocable: true`

**Phase 2.3 mid-input slash**

- [ ] После ввода `/` в теле поля ввода запускается меню автозаполнения команд (не только в начале строки)
- [ ] Меню автозаполнения отображает имя команды + description
- [ ] После выбора автозаполнения правильно заполняется в поле ввода
