# statist-plugin-install

## AIDT

AIDT-6354

## Зачем

Команде Marketplace нужна аналитика установок расширений из nessy-cli. Для
этого отливается отдельное Statist-событие `plugin.install` в выделенный
проект Marketplace `coretech.skills.marketplace` (остальная Statist-телеметрия
nessy-cli идёт в `coretech.aidt.extension`).

Событие шлётся и на успешной, и на неуспешной установке. Параметры события
(порядок важен — Marketplace маппит их позиционно в ColumnStore):

| Параметр        | Колонка ClickHouse   | Значение                                              |
| --------------- | -------------------- | ----------------------------------------------------- |
| `packageName`   | `parameters_string_0`| источник установки (`event.extension_source`, для npm — пакет) |
| `installStatus` | `parameters_string_1`| `success` / `error`                                   |
| `pluginKind`    | `parameters_string_2`| тип плагина в Marketplace (пока всегда `nessy-extension`) |

После трёх marketplace-параметров идут общие (`userId`, и `pluginType`,
проставляемый `setCommonParameters`) — как у всех остальных Statist-событий.
Они добавляются **после** позиционных, чтобы не сместить колонки `string_0/1/2`.

**Доставка на короткоживущей команде.** `nessy extensions install` завершается
через `process.exit` (успех — в `cli/config.ts`, ошибка — в самой команде)
быстрее, чем срабатывает 20-секундный интервал отправки `StatistClient`.
Поэтому событие нужно принудительно сбросить: `handleInstall` вызывает
`await flushStatistEvents()` на обоих путях до выхода.

## Реализация

Переиспользуется существующий глобальный `StatistClient` — отдельный клиент под
проект Marketplace не заводится. В Statist каждое событие в батче несёт свой
`project`, поэтому `pushEvent` принимает override проекта, и одно событие
уходит в `coretech.skills.marketplace`, не трогая остальные.

## Файлы

### Statist-модуль (форк-код, `telemetry/`)

- `packages/core/src/telemetry/statistEvents.ts` — `StatistEventName.PluginInstall`
  (`'plugin.install'`) и тип `PluginInstallStatistEventParameters` (+ в union
  `AllowedStatistParameters`).
- `packages/core/src/telemetry/statistClient.ts` — константы
  `STATIST_MARKETPLACE_PROJECT` / `MARKETPLACE_PLUGIN_KIND`; override `project`
  в `pushEvent`; метод `sendPluginInstallEvent`; метод `flush()` (немедленная
  отправка очереди); функции `recordPluginInstall` и `flushStatistEvents`.
- `packages/core/src/telemetry/index.ts` — ре-экспорт `recordPluginInstall`,
  `flushStatistEvents` (+ `STATIST_MARKETPLACE_PROJECT`, `MARKETPLACE_PLUGIN_KIND`).

### Точки подключения (upstream-файлы, минимальный diff)

- `packages/core/src/telemetry/loggers.ts` — в `logExtensionInstallEvent()`
  вызов `recordPluginInstall(...)`. Универсальная точка: ловит все пути
  установки (CLI, TUI, программно), без правок `extensionManager.ts`.
- `packages/cli/src/commands/extensions/install.ts` — `await flushStatistEvents()`
  в `handleInstall` на успешном пути и в `catch` перед `process.exit(1)`.

### Тесты

- `packages/core/src/telemetry/statistClient.test.ts` — имя/проект события,
  порядок параметров (string_0/1/2 + общие), изоляция от других событий,
  HTTP-контракт реальной отправки, поведение `flush()`.
- `packages/core/src/telemetry/loggers.test.ts` — `logExtensionInstallEvent`
  пушит событие в Statist.
- `packages/cli/src/commands/extensions/install.test.ts` — `flushStatistEvents`
  вызывается на success- и error-путях.

## Код-маркеры

```ts
// [nessy-fork] statist-plugin-install
```

Размещён в:

- `loggers.ts` — блок `recordPluginInstall` в `logExtensionInstallEvent`;
- `install.ts` — оба вызова `flushStatistEvents` (success / error);
- `statistEvents.ts` — `StatistEventName.PluginInstall`;
- `statistClient.ts` — константа `STATIST_MARKETPLACE_PROJECT`.

## Откат

1. Убрать блок `recordPluginInstall` из `logExtensionInstallEvent` в `loggers.ts`
   (и импорт `recordPluginInstall`).
2. Убрать оба `await flushStatistEvents()` из `install.ts` (и импорт).
3. Удалить из `statistClient.ts`: `STATIST_MARKETPLACE_PROJECT`,
   `MARKETPLACE_PLUGIN_KIND`, override `project` в `pushEvent`,
   `sendPluginInstallEvent`, `flush()`, `recordPluginInstall`, `flushStatistEvents`.
4. Удалить из `statistEvents.ts`: `StatistEventName.PluginInstall`, тип
   `PluginInstallStatistEventParameters` (и его член union).
5. Убрать ре-экспорты из `index.ts`.
6. Удалить тесты `statistClient.test.ts` и относящиеся к фиче проверки в
   `loggers.test.ts` / `install.test.ts`.
7. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен (внутренняя телеметрия Tinkoff/T-Bank, проект Marketplace).
