---
title: TypeScript SDK
---

# TypeScript SDK

## @nestor/nessy-cli-sdk

Минимальный экспериментальный TypeScript SDK для программного доступа к Nessy CLI.

Не стесняйтесь отправлять запросы на функции/issue/PR.

## Установка

```bash
npm install @nestor/nessy-cli-sdk
```

## Примеры использования

Полные примеры использования TypeScript SDK доступны в репозитории:

- **[Nessy CLI SDK TypeScript Example (DC Simulator)](https://nestor.pages.devplatform.tcsbank.ru/nessy-cli-sdk-typescript-example-dc-simulator/)**

## Требования

- Node.js >= 22.0.0
- [Nessy CLI](https://gitlab.tcsbank.ru/nestor/nessy-cli) >= 0.4.0 (стабильная) установлен и доступен в PATH

> **Примечание для пользователей nvm**: Если вы используете nvm для управления версиями Node.js, SDK может не иметь возможности автоматически определить исполняемый файл Nessy CLI. Вы должны явно установить опцию `pathToNessyExecutable` в полный путь к бинарному файлу `nessy`.

## Быстрый старт

```typescript
import { query } from '@nestor/nessy-cli-sdk';

// Одноходовый запрос
const result = query({
  prompt: 'Какие файлы находятся в текущем каталоге?',
  options: {
    cwd: '/path/to/project',
  },
});

// Итерация по сообщениям
for await (const message of result) {
  if (message.type === 'assistant') {
    console.log('Ассистент:', message.message.content);
  } else if (message.type === 'result') {
    console.log('Результат:', message.result);
  }
}
```

## Справочник API

### `query(config)`

Создаёт новую сессию запроса с Nessy CLI.

#### Параметры

- `prompt`: `string | AsyncIterable<SDKUserMessage>` — Подсказка для отправки. Используйте строку для одноходовых запросов или async iterable для многоходовых разговоров.
- `options`: `QueryOptions` — Опции конфигурации для сессии запроса.

#### QueryOptions

| Опция                    | Тип                                            | По умолчанию     | Описание                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                                       | `process.cwd()`  | Рабочий каталог для сессии запроса. Определяет контекст, в котором выполняются файловые операции и команды.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `model`                  | `string`                                       | -                | Модель ИИ для использования (например, `'qwen-max'`, `'qwen-plus'`, `'nessy-turbo'`). Имеет приоритет над переменными окружения `OPENAI_MODEL` и `NESSY_MODEL`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pathToNessyExecutable`  | `string`                                       | Авто-обнаружение | Путь к исполняемому файлу Nessy CLI. Поддерживает несколько форматов: `'nessy'` (нативный бинарный файл из PATH), `'/path/to/nessy'` (явный путь), `'/path/to/cli.js'` (бандл Node.js), `'node:/path/to/cli.js'` (принудительная среда выполнения Node.js), `'bun:/path/to/cli.js'` (принудительная среда выполнения Bun). Если не предоставлен, автоматически определяет из: переменная окружения `NESSY_CLI_PATH`, `~/.volta/bin/nessy`, `~/.npm-global/bin/nessy`, `/usr/local/bin/nessy`, `~/.local/bin/nessy`, `~/node_modules/.bin/nessy`, `~/.yarn/bin/nessy`. |
| `permissionMode`         | `'default' \| 'plan' \| 'auto-edit' \| 'yolo'` | `'default'`      | Режим разрешения, контролирующий одобрение выполнения инструментов. Смотрите [Режимы разрешений](#режимы-разрешений) для деталей.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `canUseTool`             | `CanUseTool`                                   | -                | Пользовательский обработчик разрешений для одобрения выполнения инструментов. Вызывается, когда инструмент требует подтверждения. Должен ответить в течение 60 секунд, иначе запрос будет автоматически отклонён. Смотрите [Пользовательский обработчик разрешений](#пользовательский-обработчик-разрешений).                                                                                                                                                                                                                                                         |
| `env`                    | `Record<string, string>`                       | -                | Переменные окружения для передачи процессу Nessy CLI. Объединяются с текущей средой процесса.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `systemPrompt`           | `string \| QuerySystemPromptPreset`            | -                | Конфигурация системной подсказки для основной сессии. Используйте строку для полной замены встроенной системной подсказки Nessy CLI или объект preset для сохранения встроенной подсказки и добавления дополнительных инструкций.                                                                                                                                                                                                                                                                                                                                     |
| `mcpServers`             | `Record<string, McpServerConfig>`              | -                | Серверы MCP (Model Context Protocol) для подключения. Поддерживает внешние серверы (stdio/SSE/HTTP) и встроенные серверы SDK. Внешние серверы конфигурируются с опциями транспорта, такими как `command`, `args`, `url`, `httpUrl` и т.д. Серверы SDK используют `{ type: 'sdk', name: string, instance: Server }`.                                                                                                                                                                                                                                                   |
| `abortController`        | `AbortController`                              | -                | Контроллер для отмены сессии запроса. Вызовите `abortController.abort()` для завершения сессии и очистки ресурсов.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `debug`                  | `boolean`                                      | `false`          | Включить режим отладки для подробного логирования от процесса CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `maxSessionTurns`        | `number`                                       | `-1` (безлимит)  | Максимальное количество ходов разговора перед автоматическим завершением сессии. Ход состоит из пользовательского сообщения и ответа ассистента.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `coreTools`              | `string[]`                                     | -                | Эквивалентно `tool.core` в settings.json. Если указано, только эти инструменты будут доступны ИИ. Пример: `['read_file', 'write_file', 'run_shell_command']`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `excludeTools`           | `string[]`                                     | -                | Эквивалентно `tool.exclude` в settings.json. Исключённые инструменты немедленно возвращают ошибку разрешения. Имеет наивысший приоритет над всеми другими настройками разрешений. Поддерживает сопоставление с паттернами: имя инструмента (`'write_file'`), класс инструмента (`'ShellTool'`) или префикс команды оболочки (`'ShellTool(rm )'`).                                                                                                                                                                                                                     |
| `allowedTools`           | `string[]`                                     | -                | Эквивалентно `tool.allowed` в settings.json. Соответствующие инструменты обходят callback `canUseTool` и выполняются автоматически. Применяется только когда инструмент требует подтверждения. Поддерживает то же сопоставление с паттернами, что и `excludeTools`.                                                                                                                                                                                                                                                                                                   |
| `authType`               | `'openai' \| 'dp-auth'`                        | `'openai'`       | Тип аутентификации для сервиса ИИ. Использование `'dp-auth'` в SDK не рекомендуется, так как учётные данные хранятся в `~/.nessy` и могут требовать периодического обновления.                                                                                                                                                                                                                                                                                                                                                                                        |
| `agents`                 | `SubagentConfig[]`                             | -                | Конфигурация для субагентов, которые могут быть вызваны во время сессии. Субагенты — это специализированные ИИ-агенты для специфичных задач или доменов.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `includePartialMessages` | `boolean`                                      | `false`          | Когда `true`, SDK выдаёт неполные сообщения по мере их генерации, позволяя потоковую передачу ответа ИИ в реальном времени.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Таймауты

SDK применяет следующие таймауты по умолчанию:

| Таймаут          | По умолчанию | Описание                                                                                                                                                   |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canUseTool`     | 1 минута     | Максимальное время для ответа callback `canUseTool`. Если превышено, запрос инструмента автоматически отклоняется.                                         |
| `mcpRequest`     | 1 минута     | Максимальное время для завершения вызовов инструментов SDK MCP.                                                                                            |
| `controlRequest` | 1 минута     | Максимальное время для завершения операций управления, таких как `initialize()`, `setModel()`, `setPermissionMode()`, `getContextUsage()` и `interrupt()`. |
| `streamClose`    | 1 минута     | Максимальное время ожидания завершения инициализации перед закрытием stdin CLI в многоходовом режиме с серверами SDK MCP.                                  |

Вы можете настроить эти таймауты через опцию `timeout`:

```typescript
const query = nessy.query('Ваша подсказка', {
  timeout: {
    canUseTool: 60000, // 60 секунд для callback разрешения
    mcpRequest: 600000, // 10 минут для вызовов инструментов MCP
    controlRequest: 60000, // 60 секунд для запросов управления
    streamClose: 15000, // 15 секунд для ожидания закрытия потока
  },
});
```

### Типы сообщений

SDK предоставляет гарды типов для идентификации различных типов сообщений:

```typescript
import {
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
} from '@nestor/nessy-cli-sdk';

for await (const message of result) {
  if (isSDKAssistantMessage(message)) {
    // Обработать сообщение ассистента
  } else if (isSDKResultMessage(message)) {
    // Обработать сообщение результата
  }
}
```

### Методы экземпляра Query

Экземпляр `Query`, возвращаемый `query()`, предоставляет несколько методов:

```typescript
const q = query({ prompt: 'Hello', options: {} });

// Получить ID сессии
const sessionId = q.getSessionId();

// Проверить, закрыта ли
const closed = q.isClosed();

// Прервать текущую операцию
await q.interrupt();

// Изменить режим разрешения во время сессии
await q.setPermissionMode('auto');

// Изменить модель во время сессии
await q.setModel('qwen-max');

// Получить разбивку использования контекстного окна (подсчёт токенов по категориям)
const usage = await q.getContextUsage();
// Передать true для подсказки о необходимости отобразить детали по элементам
const detail = await q.getContextUsage(true);

// Закрыть сессию
await q.close();
```

## Режимы разрешений

SDK поддерживает различные режимы разрешений для контроля выполнения инструментов:

- **`default`**: Инструменты записи запрещены, если не одобрены через callback `canUseTool` или в `allowedTools`. Инструменты только для чтения выполняются без подтверждения.
- **`plan`**: Блокирует все инструменты записи, инструктируя ИИ сначала представить план.
- **`auto-edit`**: Авто-одобрение инструментов редактирования (`edit`, `write_file`, `notebook_edit`), в то время как другие инструменты требуют подтверждения.
- **`yolo`**: Все инструменты выполняются автоматически без подтверждения.

### Цепочка приоритетов разрешений

1. `excludeTools` — Блокирует инструменты полностью
2. `permissionMode: 'plan'` — Блокирует инструменты, не являющиеся только для чтения
3. `permissionMode: 'auto'` — Авто-одобрение инструментов
4. `allowedTools` — Авто-одобрение соответствующих инструментов
5. callback `canUseTool` — Пользовательская логика одобрения
6. Поведение по умолчанию — Авто-отклонение в режиме SDK

## Примеры

### Многоходовой разговор

```typescript
import { query, type SDKUserMessage } from '@nestor/nessy-cli-sdk';

async function* generateMessages(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Создать файл hello.txt' },
    parent_tool_use_id: null,
  };

  // Дождаться некоторого условия или ввода пользователя
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Теперь прочитать файл обратно' },
    parent_tool_use_id: null,
  };
}

const result = query({
  prompt: generateMessages(),
  options: {
    permissionMode: 'auto-edit',
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Пользовательский обработчик разрешений

```typescript
import { query, type CanUseTool } from '@nestor/nessy-cli-sdk';

const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  // Разрешить все операции чтения
  if (toolName.startsWith('read_')) {
    return { behavior: 'allow', updatedInput: input };
  }

  // Запросить у пользователя для операций записи (в реальном приложении)
  const userApproved = await promptUser(`Разрешить ${toolName}?`);

  if (userApproved) {
    return { behavior: 'allow', updatedInput: input };
  }

  return { behavior: 'deny', message: 'Пользователь отклонил операцию' };
};

const result = query({
  prompt: 'Создать новый файл',
  options: {
    canUseTool,
  },
});
```

### С внешними серверами MCP

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Использовать пользовательский инструмент из моего сервера MCP',
  options: {
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['path/to/mcp-server.js'],
        env: { PORT: '3000' },
      },
    },
  },
});
```

### Переопределение системной подсказки

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Сказать привет в одном предложении.',
  options: {
    systemPrompt:
      'Вы лаконичный ассистент. Отвечайте ровно в одном предложении.',
  },
});
```

### Добавление к встроенной системной подсказке

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Проверить текущий каталог.',
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'nessy_cli',
      append: 'Быть кратким и сосредоточиться на конкретных находках.',
    },
  },
});
```

### Со встроенными серверами MCP SDK

SDK предоставляет `tool` и `createSdkMcpServer` для создания серверов MCP, которые выполняются в том же процессе, что и ваше приложение SDK. Это полезно, когда вы хотите предоставить пользовательские инструменты ИИ без запуска отдельного процесса сервера.

#### `tool(name, description, inputSchema, handler)`

Создаёт определение инструмента с выводом типа схемы Zod.

| Параметр      | Тип                                | Описание                                                                                |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `name`        | `string`                           | Имя инструмента (1-64 символов, начинается с буквы, алфавитно-цифровые и подчёркивания) |
| `description` | `string`                           | Человекочитаемое описание того, что делает инструмент                                   |
| `inputSchema` | `ZodRawShape`                      | Объект схемы Zod, определяющий входные параметры инструмента                            |
| `handler`     | `(args, extra) => Promise<Result>` | Асинхронная функция, которая выполняет инструмент и возвращает блоки контента MCP       |

Обработчик должен возвращать объект `CallToolResult` со следующей структурой:

```typescript
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; uri: string; mimeType?: string; text?: string }
  >;
  isError?: boolean;
}
```

#### `createSdkMcpServer(options)`

Создаёт экземпляр встроенного сервера MCP SDK.

| Опция     | Тип                      | По умолчанию | Описание                                  |
| --------- | ------------------------ | ------------ | ----------------------------------------- |
| `name`    | `string`                 | Обязательно  | Уникальное имя для сервера MCP            |
| `version` | `string`                 | `'1.0.0'`    | Версия сервера                            |
| `tools`   | `SdkMcpToolDefinition[]` | -            | Массив инструментов, созданных с `tool()` |

Возвращает объект `McpSdkServerConfigWithInstance`, который может быть передан напрямую в опцию `mcpServers`.

#### Пример

```typescript
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@nestor/nessy-cli-sdk';

// Определить инструмент со схемой Zod
const calculatorTool = tool(
  'calculate_sum',
  'Сложить два числа',
  { a: z.number(), b: z.number() },
  async (args) => ({
    content: [{ type: 'text', text: String(args.a + args.b) }],
  }),
);

// Создать сервер MCP
const server = createSdkMcpServer({
  name: 'calculator',
  tools: [calculatorTool],
});

// Использовать сервер в запросе
const result = query({
  prompt: 'Сколько будет 42 + 17?',
  options: {
    permissionMode: 'auto',
    mcpServers: {
      calculator: server,
    },
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Прерывание запроса

```typescript
import { query, isAbortError } from '@nestor/nessy-cli-sdk';

const abortController = new AbortController();

const result = query({
  prompt: 'Долго-running задача...',
  options: {
    abortController,
  },
});

// Прервать через 5 секунд
setTimeout(() => abortController.abort(), 5000);

try {
  for await (const message of result) {
    console.log(message);
  }
} catch (error) {
  if (isAbortError(error)) {
    console.log('Запрос был прерван');
  } else {
    throw error;
  }
}
```

## Обработка ошибок

SDK предоставляет класс `AbortError` для обработки прерванных запросов:

```typescript
import { AbortError, isAbortError } from '@nestor/nessy-cli-sdk';

try {
  // ... операции запроса
} catch (error) {
  if (isAbortError(error)) {
    // Обработать прерывание
  } else {
    // Обработать другие ошибки
  }
}
```
