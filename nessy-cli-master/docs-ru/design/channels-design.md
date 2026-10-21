---
title: "Дизайн каналов"
---

# Дизайн каналов

> Внешние интеграции обмена сообщениями для Nessy CLI — взаимодействие с агентом из Telegram, WeChat и других платформ.
>
> Пользовательская документация: [Обзор каналов](../users/work/features/channels/overview.md).

## Обзор

**Канал** соединяет внешнюю платформу обмена сообщениями с агентом Nessy CLI. Настраивается в `settings.json`, управляется через подкоманды `nessy channel`, поддерживает нескольких пользователей (каждый пользователь получает изолированную ACP-сессию).

## Архитектура

```
┌──────────┐                        ┌──────────────────────────────────────┐
│ Telegram │    Platform API        │         Channel Service              │
│ User A   │◄──────────────────────►│                                      │
├──────────┤  (WebSocket/polling)   │  ┌────────────┐    ┌──────────────┐  │
│ WeChat   │◄──────────────────────►│  │ Platform   │    │  ACP Bridge  │  │
│ User B   │                        │  │ Adapter    │    │  (shared)    │  │
└──────────┘                        │  │            │    │              │  │
                                    │  │ - connect  │    │  - spawns    │  │
                                    │  │ - receive  │    │    nessy-cli │  │
                                    │  │ - send     │    │  - manages   │  │
                                    │  │            │    │    sessions  │  │
                                    │  └─────┬──────┘    └──────┬───────┘  │
                                    │        │                  │          │
                                    │        ▼                  ▼          │
                                    │  ┌─────────────────────────────────┐ │
                                    │  │  SenderGate · GroupGate         │ │
                                    │  │  SessionRouter · ChannelBase    │ │
                                    │  └─────────────────────────────────┘ │
                                    └──────────────────────────────────────┘
                                                     │
                                                     │ stdio (ACP ndjson)
                                                     ▼
                                    ┌─────────────────────────────────────┐
                                    │        nessy-cli --acp              │
                                    │   Session A (user alice, id: "abc") │
                                    │   Session B (user bob,   id: "def") │
                                    └─────────────────────────────────────┘
```

**Platform Adapter** — подключается к внешнему API, транслирует сообщения в/из Envelopes. **ACP Bridge** — создаёт процесс `nessy-cli --acp`, управляет сессиями, генерирует события `textChunk`/`toolCall`/`disconnected`. **Session Router** — отображает отправителей на ACP-сессии через именованные ключи (`<channel>:<sender>`). **Sender Gate** / **Group Gate** — контроль доступа (allowlist / pairing / open) и mention gating. **Channel Base** — абстрактный базовый класс с шаблоном Template Method: плагины переопределяют `connect`, `sendMessage`, `disconnect`. **Channel Registry** — `Map<string, ChannelPlugin>` с обнаружением коллизий.

### Envelope

Нормализованный формат сообщений, в который все платформы конвертируют:

- **Identity**: `senderId`, `senderName`, `chatId`, `channelName`
- **Content**: `text`, опционально `imageBase64`/`imageMimeType`, опционально `referencedText`
- **Context**: `isGroup`, `isMentioned`, `isReplyToBot`, опционально `threadId`

Ответственности плагина: `senderId` должен быть стабильным/уникальным; `chatId` должен различать DM и группы; boolean флаги должны быть точными для логики gate; @mentions удаляются из `text`.

### Поток сообщений

```
Inbound:  User message → Adapter → GroupGate → SenderGate → Slash commands → SessionRouter → AcpBridge → Agent
Outbound: Agent response → AcpBridge → SessionRouter → Adapter → User
```

Slash команды (`/clear`, `/help`, `/status`) обрабатываются в ChannelBase до достижения агента.

### Сессии

Один процесс `nessy --acp` с несколькими ACP-сессиями. Область действия на канал: **`user`** (по умолчанию), **`thread`**, или **`single`**. Ключи маршрутизации с префиксом `<channelName>:<key>`.

### Обработка ошибок

- **Сбои подключения** — логируются; сервис продолжается, если хотя бы один канал подключён
- **Сбои Bridge** — exponential backoff (максимум 3 retry), `setBridge()` на всех каналах, восстановление сессии
- **Сериализация сессий** — цепочки промисов на сессию предотвращают коллизии промптов

## Система плагинов

Архитектура расширяема — новые адаптеры (включая сторонние) могут быть добавлены без изменения ядра. Встроенные каналы используют тот же интерфейс плагина (dogfooding).

### Контракт плагина

`ChannelPlugin` объявляет `channelType`, `displayName`, `requiredConfigFields`, и фабрику `createChannel()`. Плагины реализуют три метода:

| Метод                       | Ответственность                                              |
| --------------------------- | ------------------------------------------------------------ |
| `connect()`                 | Подключение к платформе и регистрация обработчиков сообщений |
| `sendMessage(chatId, text)` | Форматирование и доставка ответа агента                      |
| `disconnect()`              | Очистка при завершении работы                                |

При входящих сообщениях плагины строят `Envelope` и вызывают `this.handleInbound(envelope)` — базовый класс обрабатывает остальное: контроль доступа, group gating, pairing, маршрутизацию сессий, сериализацию промптов, slash команды, инъекцию инструкций, контекст ответа, восстановление после сбоев.

### Точки расширения

- Кастомные slash команды через `registerCommand()`
- Индикаторы работы через обёртывание `handleInbound()` с отображением typing/reaction
- Хуки вызова инструментов через `onToolCall()`
- Обработка медиа через прикрепление к Envelope перед `handleInbound()`

### Обнаружение и загрузка

Внешние плагины — это **расширения**, управляемые `ExtensionManager`, объявленные в `nessy-extension.json`:

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

Последовательность загрузки при `nessy channel start`: загрузка настроек → регистрация встроенных → сканирование расширений → динамический импорт + валидация → регистрация (отклонение коллизий) → валидация конфигурации → `createChannel()` → `connect()`.

Плагины работают в процессе (без песочницы), та же модель доверия, что у npm зависимостей.

## Конфигурация

```jsonc
{
  "channels": {
    "my-telegram": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN", // ссылка на переменную окружения
      "senderPolicy": "allowlist", // allowlist | pairing | open
      "allowedUsers": ["123456"],
      "sessionScope": "user", // user | thread | single
      "cwd": "/path/to/project",
      "model": "qwen3.5-plus",
      "instructions": "Keep responses short.",
      "groupPolicy": "disabled", // disabled | allowlist | open
      "groups": { "*": { "requireMention": true } },
    },
  },
}
```

Аутентификация специфична для плагина: статический токен (Telegram), учётные данные приложения (DingTalk), QR code login (WeChat), proxy token (TMCP).

## CLI команды

```bash
# Каналы
nessy channel start [name]                     # запустить все или один канал
nessy channel stop                             # остановить работающий сервис
nessy channel status                           # показать каналы, сессии, uptime
nessy channel pairing list <ch>                # ожидающие запросы pairing
nessy channel pairing approve <ch> <code>      # одобрить запрос

# Расширения
nessy extensions install <path-or-package>     # установить
nessy extensions link <local-path>             # symlink для разработки
nessy extensions list                          # показать установленные
nessy extensions remove <name>                 # удалить
```

## Структура пакетов

```
packages/channels/
├── base/                    # @nestor/nessy-cli-channel-base
│   └── src/
│       ├── AcpBridge.ts     # жизненный цикл ACP процесса, управление сессиями
│       ├── SessionRouter.ts # отображение sender ↔ session, персистентность
│       ├── SenderGate.ts    # allowlist / pairing / open
│       ├── GroupGate.ts     # политика групповых чатов + mention gating
│       ├── PairingStore.ts  # генерация + одобрение pairing кодов
│       ├── ChannelBase.ts   # абстрактный базовый: маршрутизация, slash команды
│       └── types.ts         # Envelope, ChannelConfig, etc.
├── telegram/                # @nestor/nessy-cli-channel-telegram
├── weixin/                  # @nestor/nessy-cli-channel-weixin
└── dingtalk/                # @nestor/nessy-cli-channel-dingtalk
```

## Будущая работа

### Безопасность и групповые чаты

- **Ограничения инструментов на группу** — `tools`/`toolsBySender` deny/allow списки на группу
- **История контекста группы** — ring buffer недавних пропущенных сообщений, добавляется при @mention
- **Regex паттерны упоминаний** — fallback `mentionPatterns` для ненадёжных @mention метаданных
- **Инструкции на группу** — поле `instructions` в `GroupConfig` для персон на группу
- **Команда `/activation`** — runtime переключатель для `requireMention`, персистентность на диск

### Операционные инструменты

- **`nessy channel doctor`** — валидация конфигурации, переменных окружения, бот токенов, сетевые проверки
- **`nessy channel status --probe`** — реальные проверки подключения на канал

### Расширение платформ

- **Discord** — Bot API + Gateway, серверы/каналы/DM/треды
- **Slack** — Bolt SDK, Socket Mode, workspace/каналы/DM/треды

### Мульти-агент

- **Маршрутизация нескольких агентов** — несколько агентов с bindings на канал/группу/пользователя
- **Вещательные группы** — несколько агентов отвечают на одно сообщение

### Экосистема плагинов

- **Реестр/обнаружение плагинов** — `nessy extensions search`, совместимость версий
