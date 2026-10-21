---
title: Канальные плагины
sidebar_position: 4
---

# Руководство разработчика канальных плагинов

Канальный плагин подключает Nessy CLI к платформе обмена сообщениями. Он упаковывается как [расширение](../users/work/extension/introduction.md) и загружается при запуске. Пользовательскую документацию по установке и настройке плагинов смотрите в разделе [Плагины](../users/work/features/channels/plugins.md).

## Как это работает вместе

Ваш плагин находится на уровне адаптера платформы. Вы обрабатываете платформо-специфичные задачи (подключение, получение сообщений, отправка ответов). `ChannelBase` берёт на себя всё остальное (контроль доступа, маршрутизация сессий, очередь промптов, slash-команды, восстановление после сбоев).

```
Your Plugin  →  builds Envelope  →  handleInbound()
ChannelBase  →  gates → commands → routing → AcpBridge.prompt()
ChannelBase  →  calls your sendMessage() with the agent's response
```

## Объект плагина

Точка входа вашего расширения экспортирует объект `plugin`, соответствующий интерфейсу `ChannelPlugin`:

```typescript
import type { ChannelPlugin } from '@nestor/nessy-cli-channel-base';
import { MyChannel } from './MyChannel.js';

export const plugin: ChannelPlugin = {
  channelType: 'my-platform', // Unique ID, used in settings.json "type" field
  displayName: 'My Platform', // Shown in CLI output
  requiredConfigFields: ['apiKey'], // Validated at startup (beyond standard ChannelConfig)
  createChannel: (name, config, bridge, options) =>
    new MyChannel(name, config, bridge, options),
};
```

## Адаптер канала

Наследуйте `ChannelBase` и реализуйте три метода:

```typescript
import { ChannelBase } from '@nestor/nessy-cli-channel-base';
import type { Envelope } from '@nestor/nessy-cli-channel-base';

export class MyChannel extends ChannelBase {
  async connect(): Promise<void> {
    // Connect to your platform, register message handlers
    // When a message arrives:
    const envelope: Envelope = {
      channelName: this.name,
      senderId: '...', // Stable, unique platform user ID
      senderName: '...', // Display name
      chatId: '...', // Chat/conversation ID (distinct for DMs vs groups)
      text: '...', // Message text (strip @mentions)
      isGroup: false, // Accurate — used by GroupGate
      isMentioned: false, // Accurate — used by GroupGate
      isReplyToBot: false, // Accurate — used by GroupGate
    };
    this.handleInbound(envelope);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Format markdown → platform format, chunk if needed, deliver
  }

  disconnect(): void {
    // Clean up connections
  }
}
```

## Конверт (Envelope)

Нормализованный объект сообщения, который вы создаёте из данных платформы. Булевые флаги управляют логикой фильтрации, поэтому они должны быть точными.

| Поле             | Тип          | Обязательно | Описание                                                                                     |
| ---------------- | ------------ | ----------- | -------------------------------------------------------------------------------------------- |
| `channelName`    | string       | Да          | Используйте `this.name`                                                                      |
| `senderId`       | string       | Да          | Должен быть стабильным между сообщениями (используется для маршрутизации и контроля доступа) |
| `senderName`     | string       | Да          | Отображаемое имя                                                                             |
| `chatId`         | string       | Да          | Должен различать ЛС и группы                                                                 |
| `text`           | string       | Да          | Без @упоминаний бота                                                                         |
| `threadId`       | string       | Нет         | Для `sessionScope: "thread"`                                                                 |
| `messageId`      | string       | Нет         | ID сообщения платформы — полезен для корреляции ответов                                      |
| `isGroup`        | boolean      | Да          | GroupGate полагается на это                                                                  |
| `isMentioned`    | boolean      | Да          | GroupGate полагается на это                                                                  |
| `isReplyToBot`   | boolean      | Да          | GroupGate полагается на это                                                                  |
| `referencedText` | string       | Нет         | Цитируемое сообщение — добавляется как контекст                                              |
| `imageBase64`    | string       | Нет         | Base64-кодированное изображение (устаревшее — используйте `attachments`)                     |
| `imageMimeType`  | string       | Нет         | Например, `image/jpeg` (устаревшее — используйте `attachments`)                              |
| `attachments`    | Attachment[] | Нет         | Структурированные медиа-вложения (см. ниже)                                                  |

### Вложения

Используйте массив `attachments` для изображений, файлов, аудио и видео. `handleInbound()` обрабатывает их автоматически: изображения с base64 `data` отправляются модели как визуальный ввод, файлы с `filePath` — путь добавляется к промпту, чтобы агент мог их прочитать.

```typescript
interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  data?: string; // base64-encoded data (images, small files)
  filePath?: string; // absolute path to local file (large files saved to disk)
  mimeType: string; // e.g. 'application/pdf', 'image/jpeg'
  fileName?: string; // original file name from the platform
}
```

Пример — обработка загрузки файла в вашем адаптере:

```typescript
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buf = await downloadFromPlatform(fileId);
const dir = join(tmpdir(), 'channel-files');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const filePath = join(dir, fileName);
writeFileSync(filePath, buf);

envelope.attachments = [
  {
    type: 'file',
    filePath,
    mimeType: 'application/pdf',
    fileName,
  },
];
```

Устаревшие поля `imageBase64`/`imageMimeType` по-прежнему работают для обратной совместимости, но для нового кода рекомендуется использовать `attachments`.

## Манифест расширения

Ваш `nessy-extension.json` объявляет тип канала. Ключ должен совпадать с `channelType` в объекте плагина:

```json
{
  "name": "my-channel-extension",
  "version": "1.0.0",
  "channels": {
    "my-platform": {
      "entry": "dist/index.js",
      "displayName": "My Platform Channel"
    }
  }
}
```

## Опциональные точки расширения

**Пользовательские slash-команды** — регистрируйте в конструкторе:

```typescript
this.registerCommand('mycommand', async (envelope, args) => {
  await this.sendMessage(envelope.chatId, 'Response');
  return true; // handled, don't forward to agent
});
```

**Индикаторы работы** — переопределите `onPromptStart()` и `onPromptEnd()` для отображения платформо-специфичных индикаторов набора текста. Эти хуки срабатывают только когда промпт действительно начинает обрабатываться — не для буферизованных сообщений (режим collect) и не для заблокированных сообщений:

```typescript
protected override onPromptStart(chatId: string, sessionId: string, messageId?: string): void {
  this.platformClient.sendTyping(chatId); // your platform API
}

protected override onPromptEnd(chatId: string, sessionId: string, messageId?: string): void {
  this.platformClient.stopTyping(chatId);
}
```

**Хуки вызова инструментов** — переопределите `onToolCall()` для отображения активности агента (например, "Выполнение команды оболочки...").

**Хуки стриминга** — переопределите `onResponseChunk(chatId, chunk, sessionId)` для построчного прогрессивного отображения (например, редактирование сообщения на месте). Переопределите `onResponseComplete(chatId, fullText, sessionId)` для настройки финальной доставки.

**Блочный стриминг** — установите `blockStreaming: "on"` в конфигурации канала. Базовый класс автоматически разбивает ответы на несколько сообщений по границам абзацев. Код плагина не нужен — это работает совместно с `onResponseChunk`.

**Медиа** — заполните `envelope.attachments` изображениями/файлами. Смотрите [Вложения](#вложения) выше.

## Справочные реализации

- **Пример плагина** (`packages/channels/plugin-example/`) — минимальный адаптер на WebSocket, хорошая отправная точка
- **Telegram** (`packages/channels/telegram/`) — полнофункциональный: изображения, файлы, форматирование, индикаторы набора
- **DingTalk** (`packages/channels/dingtalk/`) — потоковый с обработкой rich-text
