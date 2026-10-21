---
title: Обнаружение изменений файла настроек
---

# Обнаружение изменений файла настроек (Подзадача #3696 1)

## Контекст

Nessy CLI в настоящее время не имеет механизма обнаружения изменений файла настроек. Пользователи должны перезапускать сессию после изменения `settings.json`, чтобы изменения вступили в силу. Это предложение реализует инфраструктурный слой для системы горячей перезагрузки #3696 — автоматическое обнаружение и диспетчеризация событий для изменений файла настроек.

**Область**: Эта подзадача отвечает только за «обнаружение изменений файла → перезагрузка → уведомление слушателей». `Config` копирует многие поля настроек во время конструкции (`approvalMode`, `mcpServers`, `telemetry` и т.д.), и эти снимки **НЕ** автоматически обновляются этой подзадачей. Только потребители, которые читают `LoadedSettings.merged` в реальном времени (например, хук `useSettings()`, `disabledSkillNamesProvider`), немедленно увидят изменения. Другие подзадачи (повторное подключение MCP, команда `/reload`) отвечают за передачу обновлений во внутреннее состояние Config.

## Архитектурные решения

### Расположение модуля: `packages/cli/src/config/settingsWatcher.ts`

- `LoadedSettings` и пути к файлам настроек находятся в `packages/cli`
- `reloadScopeFromDisk()` — метод на `LoadedSettings`
- Базовый пакет получает только минимальный интерфейс жизненного цикла `{ stopWatching(): void }`, без импорта типов CLI, таких как `SettingScope`
- Диспетчеризация событий изменений и логика downstream-обновления полностью подключены в слое CLI

### Стратегия наблюдения: Наблюдение за родительским каталогом + строгая фильтрация путей

Поток записи `writeWithBackupSync` — `write(.tmp) → rename(target, .orig) → rename(.tmp, target) → unlink(.orig)`, что приводит к кратковременному исчезновению целевого файла. Наблюдение за путём файла напрямую заставит chokidar потерять наблюдение. Поэтому мы наблюдаем за родительским каталогом (`depth: 0`) и фильтруем по **точному совпадению имени базового файла**, отвечая только на события файла `settings.json` и игнорируя `.tmp`, `.orig`, временные файлы редактора и т.д. Резервная копия `.orig` — это защитный механизм во время выполнения и **удаляется при успехе** (финальный шаг `unlink`), поэтому она никогда не задерживается в каталоге пользователя.

### Ленивая обработка каталога: Никогда не создавать `.nessy/` при запуске

> **Побочный эффект файловой системы при запуске (намеренно избегается).** Наблюдатель **никогда** не должен создавать `<project>/.nessy/` (или `~/.nessy/`) просто для того, чтобы иметь возможность наблюдать. Более ранняя версия вызывала `mkdirSync({ recursive: true })` для любого отсутствующего каталога настроек, что означало, что обычный небare-запуск молча создавал `<project>/.nessy/` даже в проектах, которые никогда не имели настроек Nessy — загрязняя рабочее пространство и статус git. Создание каталога принадлежит исключительно **персистентности** настроек (`saveSettings()` делает свой собственный `mkdirSync`, когда пользователь фактически записывает настройки).

Чтобы по-прежнему обнаружить `settings.json`, добавленный позже в сессии, без создания каталога и без рекурсии дерева проекта, наблюдатель использует двухэтапную стратегию для каждой области, ключом которой является существование **каталога**:

- **`.nessy` существует при запуске** → наблюдать за ним напрямую (`watchTargetDir`, стратегия выше).
- **`.nessy` отсутствует** → **bootstrap-наблюдение за родителем** (`watchParentForDir`): `chokidar.watch(parentDir, { depth: 0, ignoreInitial: true, ignored })`, где предикат `ignored` `(p) => p !== parentDir && basename(p) !== '.nessy'` позволяет пройти **только** записи `.nessy`. Это подавляет весь несвязанный износ верхнего уровня и никогда не рекурсирует. Как только `.nessy` появляется, наблюдатель **повышается**: он закрывает bootstrap-наблюдатель и запускает целевой наблюдатель на `.nessy`, затем планирует обновление, чтобы подобрать `settings.json`, который может уже быть внутри.

Детали надёжности:

- **TOCTOU guard**: после вооружения bootstrap-наблюдателя (который использует `ignoreInitial`), `existsSync(dir)` проверяется повторно; если `.nessy` был создан в промежутке, повышение происходит немедленно.
- **Demote on removal**: если `.nessy` сам удалён (`unlinkDir`), целевой наблюдатель понижается обратно к родительскому bootstrap-наблюдателю, поэтому позднее повторное создание всё ещё перехватывается.
- **Generation guard**: chokidar `close()` асинхронен, поэтому устаревший обратный вызов `'all'` от наблюдателя, который разбирается, может иначе повторно запустить повышение и сложить наблюдателей. Монотонный токен поколения для каждой области (увеличиваемый при каждом повышении/понижении и при `stopWatching`) делает устаревшие обратные вызовы no-ops, гарантируя не более одного активного наблюдателя на область.

### Обнаружение изменений: Семантическое diff как основной механизм дедупликации

Каждый раз, когда наблюдатель срабатывает, он сначала делает снимок **текущего состояния в памяти перед перезагрузкой** (`JSON.stringify(file.settings)`), затем вызывает `reloadScopeFromDisk()` для перезагрузки и, наконец, сравнивает снимки до/после. Слушатели уведомляются только тогда, когда семантическое содержимое фактически изменилось.

Ключ: сравнение между состоянием в памяти **до и после перезагрузки**, а не против сохранённого исторического снимка. Это потому, что `setValue()` синхронно обновляет `file.settings` в памяти перед записью на диск, поэтому, когда наблюдатель запускает перезагрузку, состояние в памяти уже содержит само-записанное значение — перезагрузка производит одинаковое содержимое → нет diff → нет уведомления.

Это естественно подавляет:

- Дублирующиеся события от само-записей (`setValue()` уже обновил память, перезагрузка производит идентичное содержимое → нет diff → нет уведомления)
- Изменения только формата/комментариев (разрешённые настройки не включают комментарии)
- Сохранения редактора без изменения содержимого
- Дублирующиеся события chokidar

Известное ограничение: `JSON.stringify` чувствителен к порядку ключей. Если пользователь вручную переупорядочивает ключи в settings.json без изменения значений, это запустит одно безвредное дополнительное уведомление. Это приемлемо; нет необходимости вводить зависимость deep-equal.

## Реализация

### 1. Новый класс `SettingsWatcher`

**Файл**: `packages/cli/src/config/settingsWatcher.ts`

```typescript
export interface SettingsChangeEvent {
  scope: SettingScope;
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

export type SettingsChangeListener = (
  events: SettingsChangeEvent[],
) => void | Promise<void>;

export class SettingsWatcher {
  private readonly settings: LoadedSettings;
  private readonly watchers: Map<SettingScope, FSWatcher> = new Map();
  // 'bootstrap' = наблюдение за родителем для `.nessy`; 'target' = наблюдение за `.nessy`
  private readonly watchStage: Map<SettingScope, 'bootstrap' | 'target'> =
    new Map();
  // Монотонный токен поколения для каждой области; увеличивается при повышении/понижении, чтобы аннулировать устаревшие обратные вызовы
  private readonly watchGeneration: Map<SettingScope, number> = new Map();
  private readonly changeListeners: Set<SettingsChangeListener> = new Set();
  private refreshTimer: NodeJS.Timeout | null = null;
  private pendingScopeChanges: Set<SettingScope> = new Set();
  private processing: boolean = false; // guard сериализации
  private started: boolean = false;

  static readonly DEBOUNCE_MS = 300;
  static readonly LISTENER_TIMEOUT_MS = 30_000;
}
```

**Основные методы**:

#### `startWatching()`

- Итерирует обе области User и Workspace
- Ветвится на существовании **каталога**: наблюдать за `.nessy` напрямую, если он существует, иначе bootstrap-наблюдение за родителем (см. [Ленивая обработка каталога](#lazy-directory-handling-never-create-nessy-at-startup))
- **Никогда** не создаёт каталог — нет `mkdirSync`
- `ignoreInitial: true`, `depth: 0` на всём протяжении
- Не вызывается в bare-режиме

```typescript
startWatching(): void {
  if (this.started) return;
  this.started = true;

  for (const { scope, settingsPath } of this.getScopePaths()) {
    if (!settingsPath) continue;
    const dir = path.dirname(settingsPath);
    // Никогда не создавать каталог; персистентность настроек (saveSettings) владеет этим.
    if (fs.existsSync(dir)) {
      this.watchTargetDir(scope, settingsPath);
    } else {
      this.watchParentForDir(scope, settingsPath);
    }
  }
}
```

`watchTargetDir` — это наблюдатель родительского каталога + строгого базового имени, описанный выше (он также понижается обратно к bootstrap-наблюдателю, если `.nessy` сам удалён). `watchParentForDir` вооружает bootstrap-наблюдатель только для `.nessy` и повышает, как только `.nessy` появляется:

```typescript
private watchParentForDir(scope: SettingScope, settingsPath: string): void {
  const dir = path.dirname(settingsPath);
  const parentDir = path.dirname(dir);
  const dirBasename = path.basename(dir); // ".nessy"
  const gen = this.bumpGeneration(scope);

  const watcher = watchFs(parentDir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (filePath: string) =>
      filePath !== parentDir && path.basename(filePath) !== dirBasename,
  })
    .on('all', (_event: string, changedPath: string) => {
      if (this.watchGeneration.get(scope) !== gen) return; // устаревший обратный вызов
      if (path.basename(changedPath) !== dirBasename) return;
      void this.promoteScope(scope, settingsPath);
    })
    .on('error', (error: unknown) => {
      debugLogger.warn(`Settings bootstrap watcher error for ${parentDir}:`, error);
    });

  this.watchers.set(scope, watcher);
  this.watchStage.set(scope, 'bootstrap');

  // TOCTOU guard: `.nessy` мог появиться между проверкой существования и здесь.
  if (fs.existsSync(dir)) void this.promoteScope(scope, settingsPath);
}

private async promoteScope(scope: SettingScope, settingsPath: string): Promise<void> {
  if (this.watchStage.get(scope) !== 'bootstrap') return; // guard двойного повышения
  await this.replaceWatcher(scope); // увеличивает поколение + ожидает асинхронного close()
  if (!this.started) return;
  this.watchTargetDir(scope, settingsPath);
  this.scheduleRefresh(scope); // подобрать settings.json уже внутри .nessy
}
```

#### `stopWatching()` — Идемпотентное завершение

```typescript
stopWatching(): void {
  if (!this.started) return;
  this.started = false;
  for (const [, watcher] of this.watchers) {
    watcher.close().catch((err) => debugLogger.warn('Watcher close error:', err));
  }
  this.watchers.clear();
  if (this.refreshTimer) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
  this.pendingScopeChanges.clear();
}
```

#### `scheduleRefresh(scope)` — 300мс debounce + накопление области

```typescript
private scheduleRefresh(scope: SettingScope): void {
  this.pendingScopeChanges.add(scope);
  if (this.refreshTimer) clearTimeout(this.refreshTimer);
  this.refreshTimer = setTimeout(() => {
    this.refreshTimer = null;
    void this.drainPendingChanges();
  }, SettingsWatcher.DEBOUNCE_MS);
}
```

#### `drainPendingChanges()` — Сериализованная обработка для предотвращения повторного входа

```typescript
private async drainPendingChanges(): Promise<void> {
  if (this.processing) return; // предыдущий раунд всё ещё выполняется; он сольёт при выходе
  this.processing = true;
  try {
    while (this.pendingScopeChanges.size > 0) {
      const scopes = new Set(this.pendingScopeChanges);
      this.pendingScopeChanges.clear();
      await this.handleChange(scopes);
    }
  } finally {
    this.processing = false;
  }
}
```

#### `handleChange(scopes)` — Перезагрузка + семантическое diff + уведомление

```typescript
private async handleChange(changedScopes: Set<SettingScope>): Promise<void> {
  const events: SettingsChangeEvent[] = [];

  for (const scope of changedScopes) {
    const file = this.settings.forScope(scope);

    // Снимок текущего состояния в памяти перед перезагрузкой (включает мутации setValue())
    const beforeSettings = JSON.stringify(file.settings);
    const existedBefore = file.rawJson !== undefined;

    // reloadScopeFromDisk имеет внутренний try/catch; при ошибке парсинга сохраняет старое состояние
    this.settings.reloadScopeFromDisk(scope);

    const afterSettings = JSON.stringify(file.settings);
    const existsNow = file.rawJson !== undefined;

    // Семантическое diff: уведомлять только когда содержимое фактически изменилось
    // Подавление само-записи: setValue() уже обновил память → перезагрузка совпадает → нет уведомления
    if (afterSettings === beforeSettings) continue;

    events.push({
      scope,
      path: file.path,
      changeType: !existedBefore && existsNow ? 'created'
                : existedBefore && !existsNow ? 'deleted'
                : 'modified',
    });
  }

  if (events.length > 0) {
    await this.notifyListeners(events);
  }
}
```

#### `notifyListeners(events)` — `Promise.allSettled()` + 30с таймаут

Повторно использует паттерн уведомления слушателя SkillManager (`packages/core/src/skills/skill-manager.ts:188-236`): каждый слушатель обёрнут в 30с таймаут-гонку, выполняется параллельно через `Promise.allSettled`, сбои не распространяются.

#### `addChangeListener(listener)` — Возвращает функцию отписки

### 2. Модификации `LoadedSettings`

**Файл**: `packages/cli/src/config/settings.ts`

**Модификации не требуются**. Механизм семантического diff полностью содержится в наблюдателе. `setValue()` синхронно обновляет память → `saveSettings()` записывает на диск → наблюдатель запускается → `reloadScopeFromDisk()` перезагружает → сравнение diff находит идентичное содержимое → нет уведомления. Цепь замыкается естественно.

### 3. Интеграция Config (минимальный интерфейс)

**Файл**: `packages/core/src/config/config.ts`

Добавить в `ConfigParameters`:

```typescript
/** Lifecycle handle for an external file watcher. Stopped during shutdown. */
settingsWatcher?: { stopWatching(): void };
```

В `Config.shutdown()` остановить наблюдатель **перед** проверкой `initialized`:

```typescript
async shutdown(): Promise<void> {
  try {
    // Остановить внешний наблюдатель независимо от состояния инициализации
    this.settingsWatcher?.stopWatching();

    if (!this.initialized) return;
    // ... оставшаяся логика очистки ...
  }
}
```

**В Config не добавляются settingsChangeListeners**. Диспетчеризация событий изменений обрабатывается полностью в слое CLI, где слушатели напрямую вызывают методы обновления ядра (например, `skillManager.refreshCache()`, `toolRegistry.restartMcpServers()`). Это держит ядро в неведении относительно семантики изменений настроек.

### 4. Подключение при запуске

**Файл**: `packages/cli/src/gemini.tsx`

После `loadSettings()` и `loadCliConfig()`:

```typescript
// Создать наблюдатель (пропустить в bare-режиме)
const settingsWatcher = isBareMode(argv.bare) ? undefined : new SettingsWatcher(settings);
settingsWatcher?.startWatching();

// Передать handle жизненного цикла наблюдателя при загрузке CLI config
const config = await loadCliConfig(settings.merged, argv, ..., {
  settingsWatcher,
});

// Зарегистрировать слушателя изменений (будущие подзадачи добавят фактическую логику обновления здесь)
settingsWatcher?.addChangeListener(async (events) => {
  debugLogger.info('Settings changed:', events.map(e => `${e.scope}:${e.changeType}`));
  // Подзадачи 2-6 добавят:
  // - skillManager.refreshCache()
  // - toolRegistry.restartMcpServers()
  // - clearAllCaches()
  // - needsRefresh flag
});
```

**Изменение сигнатуры `loadCliConfig`** (`packages/cli/src/config/config.ts`): Добавить необязательный параметр для передачи `settingsWatcher` в `ConfigParameters`.

## Обработка граничных случаев

| Сценарий                                 | Обработка                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Каталог `.nessy` не существует           | **Никогда не создаётся.** Bootstrap-наблюдение за родителем (`depth: 0`, фильтр только `.nessy`), повышение при появлении `.nessy` |
| `.nessy` создан после запуска            | Bootstrap-наблюдатель перехватывает `addDir`, повышается до целевого наблюдателя + планирует обновление                        |
| `.nessy` удалён после повышения          | Целевой наблюдатель перехватывает `unlinkDir` → понижается обратно к родительскому bootstrap-наблюдателю                               |
| Файл удалён                             | `reloadScopeFromDisk` обнаруживает `!existsSync`, сбрасывает в `{}`, diff запускает событие `deleted`                    |
| Файл создан после запуска (каталог существовал) | Наблюдатель каталога перехватывает событие `add`, `reloadScopeFromDisk` читает новый файл                               |
| Устаревший обратный вызов во время повышения/понижения     | Токен поколения для каждой области делает in-flight обратный вызов закрывающегося наблюдателя no-op (без сложения наблюдателей)       |
| Атомарные записи редактора                     | Наблюдение за каталогом + строгая фильтрация базового имени (исключает `.tmp`/`.orig`) + 300мс debounce coalescing          |
| События файлов `.tmp`/`.orig`               | Фильтр базового имени точно совпадает с `settings.json`, все другие имена файлов игнорируются                                |
| Само-запись (`setValue` → `saveSettings`) | Семантическое diff: содержимое перезагрузки совпадает со снимком в памяти → нет уведомления                                    |
| Само-запись одновременна с внешним редактированием | Внешнее редактирование изменяет содержимое → diff обнаруживает изменение → корректно уведомляет                                  |
| Изменения только формата/комментариев              | `reloadScopeFromDisk` разрешает настройки без комментариев → diff совпадает → нет уведомления                     |
| Дублирующиеся события chokidar                | Debounce coalescing + семантическое diff обеспечивают двойную защиту                                                   |
| Перенаправление `NESSY_HOME`                     | `getUserSettingsPath()` уже разрешает путь; наблюдатель использует разрешённый путь                             |
| Bare-режим                                | `startWatching()` никогда не вызывается, нулевые накладные расходы                                                              |
| Сбой создания наблюдателя                 | Исключение перехвачено, предупреждение записано в лог, эта область не имеет обнаружения в реальном времени, но функциональность не затронута       |
| Сбой парсинга `reloadScopeFromDisk`      | Внутренний try/catch (`settings.ts:501`) сохраняет старое состояние → diff до/после совпадает → нет уведомления      |
| Изменение порядка ключей (без изменения значения)       | `JSON.stringify` чувствителен к порядку ключей; может произвести одно безвредное дополнительное уведомление                       |
| Сбой инициализации Config            | `shutdown()` останавливает наблюдатель перед проверкой `initialized`, предотвращая утечки                                       |
| Повторный вход (слушатель всё ещё выполняется)     | Флаг `processing` + цикл `drainPendingChanges` сериализуют обработку                                          |
| Неверный JSON                             | Внутренний try/catch `reloadScopeFromDisk` сохраняет старое состояние                                                  |

## Анализ производительности

- Не более 1 наблюдателя на область (≤ 2 всего), каждый на `depth: 0` — минимальные накладные расходы на файловый дескриптор; повышение/понижение меняют наблюдателей, никогда не складывают их
- `depth: 0` означает **отсутствие рекурсивного обхода** дерева проекта, даже для родительского bootstrap-наблюдателя в большом монорепозитории. Стоимость ограничена прямыми дочерними элементами родительского каталога: несвязанный износ верхнего уровня будит chokidar для одного `readdir` + прохода фильтра `ignored` (`O(записей верхнего уровня)`) перед подавлением события — никогда рекурсивного сканирования
- 300мс debounce гарантирует, что быстрые сохранения редактора не запускают несколько перезагрузок
- `reloadScopeFromDisk` использует синхронный `readFileSync`, < 1мс на вызов
- Сравнение `JSON.stringify` — O(n), но объекты настроек обычно < 10KB; не требуется дополнительного хранения снимка
- Уведомление слушателя выполняется параллельно через `Promise.allSettled`
- Без опроса — полностью управляется событиями

## Файлы для создания/изменения

**Новые файлы**:

- `packages/cli/src/config/settingsWatcher.ts` — класс наблюдателя
- `packages/cli/src/config/settingsWatcher.test.ts` — модульные тесты

**Изменённые файлы**:

- `packages/core/src/config/config.ts` — добавить поле `settingsWatcher` в `ConfigParameters`, вызвать `stopWatching()` перед проверкой `initialized` в `Config.shutdown()`
- `packages/cli/src/config/config.ts` (`loadCliConfig`) — добавить необязательный параметр для передачи `settingsWatcher`
- `packages/cli/src/gemini.tsx` — создать наблюдатель + подключение

**Модификации не требуются**: `packages/cli/src/config/settings.ts` (семантическое diff самодостаточно и не требует сотрудничества от `LoadedSettings`)

## План тестирования

### Модульные тесты (`settingsWatcher.test.ts`)

Mock chokidar (повторное использование паттерна mock `skill-manager.test.ts`):

1. **Жизненный цикл**: `startWatching` создаёт наблюдателей, `stopWatching` закрывает наблюдателей, оба идемпотентны
2. **Фильтрация путей**: Только события базового имени `settings.json` запускают обновление; `.tmp`/`.orig`/другие файлы игнорируются
3. **Debouncing**: Множественные быстрые события объединяются в одну перезагрузку (`vi.useFakeTimers()`)
4. **Семантическое diff**: Неизменённое содержимое → слушатель не вызван; изменённое содержимое → слушатель вызван с правильными событиями
5. **Подавление само-записи**: События наблюдателя, запущенные `setValue()`, естественно фильтруются идентичным diff
6. **Сериализация**: Новые события во время `handleChange` накапливаются, сливаются после завершения обработки
7. **Изоляция ошибок**: Ошибки chokidar не ломают; исключения слушателя не влияют на другие слушатели; сбои `reloadScopeFromDisk` перехватываются
8. **Таймаут слушателя**: 30с защита таймаутом
9. **Ленивое наблюдение за каталогом**: когда `.nessy` отсутствует, `mkdirSync` никогда не вызывается; bootstrap-наблюдатель вооружён на родителе и его предикат `ignored` позволяет пройти только записи `.nessy`
10. **Повышение / TOCTOU**: Появление `.nessy` (через `addDir` или повторную проверку после вооружения) закрывает bootstrap-наблюдатель и открывает целевой наблюдатель на `.nessy` + планирует обновление
11. **Понижение / повторное создание**: удаление `.nessy` (`unlinkDir`) повторно запускает bootstrap на родителе; последующее повторное создание снова повышает
12. **Generation guard**: Устаревший обратный вызов от уже-закрытого bootstrap-наблюдателя не создаёт второй целевой наблюдатель

### Регрессионная проверка

```bash
cd packages/cli && npx tsc --noEmit
cd packages/core && npx tsc --noEmit
cd packages/cli && npx vitest run src/config/
cd packages/core && npx vitest run src/config/
```

### Ручная проверка

Отредактировать `~/.nessy/settings.json` во время работающей сессии и наблюдать вывод отладочного лога для событий изменений.

---

## Последующая подзадача: Подавление событий для требующих перезапуска и чувствительных настроек

> **Статус: шлюз подавления реализован; две коррекции схемы всё ещё ожидаются
> исследования.** Подзадача 1 выше emit'ила одно `SettingsChangeEvent` на область
> для _любого_ семантического изменения. Это последующее добавление добавляет фильтр, так что изменения,
> ограниченные настройками, которые не могут действительно вступить в силу без перезапуска — или которые
> чувствительны (учётные данные) — **не** уведомляют слушателей.
>
> - **Выполнено:** шлюз подавления на основе `requiresRestart` в
>   `SettingsWatcher.handleChange()` плюс модульные тесты (см. Механизм ниже).
> - **Ожидается:** две коррекции схемы `requiresRestart`
>   (`modelProviders` → `true`, `permissions.*` → оставить hot-reloadable), каждая
>   защищена проверкой фактического пути чтения runtime сначала.

### Мотивация

Некоторые настройки читаются ровно один раз во время запуска процесса (`Config.initialize()`,
конструкция клиента/генератора содержимого, порождение дочернего процесса, флаги runtime Node). Примеры, которые пользователь явно назвал: **API-токены, `env` и провайдеры моделей**. Emit события горячей перезагрузки для них активно вводит в заблуждение — слушатель будет «обновлять», но новое значение фактически не применится до тех пор, пока пользователь не перезапустит `nessy-cli`. Чувствительные значения (учётные данные) дополнительно не должны повторно передаваться через работающую сессию.

### Решение: Повторное использование флага `requiresRestart` схемы (единый источник истины)

`settingsSchema.ts` уже объявляет `requiresRestart: boolean` на **каждом** ключе,
и `packages/cli/src/utils/settingsUtils.ts` уже предоставляет поиски:

- `requiresRestart(key: string): boolean` — флаг для ключа dot-path
- `getFlattenedSchema()` — полная карта «плоской» схемы `key → definition`
- `getRestartRequiredSettings()` — все ключи с `requiresRestart: true`

Мы будем **повторно использовать этот флаг как сигнал подавления**, а не поддерживать отдельный ручной список запрета (который неизбежно будет дрейфовать от схемы).
`requiresRestart: true` уже означает точно «не вступит в силу без перезапуска», что является именно условием, при котором событие должно быть подавлено.

### Механизм (реализовано в `SettingsWatcher.handleChange()`)

Старый шлюз делал diff всего файла `JSON.stringify` и не мог сказать _какие_
ключи изменились. Он заменён на diff на уровне листьев + классификацию для каждого ключа:

1. **`collectChangedKeys(before, after)`** делает снимок состояния в памяти перед
   перезагрузкой (`structuredClone`), затем проходит до/после и собирает dot-path
   каждого листа, значение которого отличается. Плоские объекты рекурсируются; массивы и примитивы
   сравниваются целиком (соответствует ключам схемы массивов, таким как
   `permissions.allow`). Добавленные/удалённые ключи появляются как изменённые листья, поэтому
   создание/удаление файла покрывается без отдельной проверки существования.
2. **`isRestartRequiredKey(path)`** разрешает каждый изменённый путь против
   схемы, используя **самый длинный ключ схемы, который является префиксом (или равен)**
   пути. Настройки свободных объектов (`env`, `modelProviders`) — это ключи листьев схемы,
   поэтому `env.FOO` разрешается к определению `env`. Неизвестные ключи по умолчанию
   **не** требуют перезапуска, поэтому изменение, которое мы не можем классифицировать, никогда не подавляется молча.
3. Область уведомляет **только если хотя бы один изменённый ключ является hot-reloadable**
   (`!isRestartRequiredKey`). Если каждый изменённый ключ требует перезапуска,
   область не производит события.

`SettingsChangeEvent` несёт выжившие изменённые ключи на событии, оставляется как возможное более позднее
улучшение. Подавление само-записи (пустой diff → нет события), debounce,
сериализация и поведение таймаута слушателя остаются неизменными.

### Две корректировки схемы для исследования и применения

Эти два значения `requiresRestart` должны быть исправлены, чтобы подход повторного использования
работал как задумано. **Каждое требует проверки фактического пути чтения runtime
перед переворачиванием флага.**

1. **`modelProviders`: `false` → `true`** (`settingsSchema.ts:294`)
   - Сегодня он помечен как `requiresRestart: false`, поэтому в рамках подхода повторного использования он
     _не_ будет подавлен — противореча требованию, что изменения провайдера не должны hot-reload'иться.
   - Конфигурация провайдера (включая `apiKey` / `baseUrl` на уровень провайдера) потребляется, когда клиент модели / генератор содержимого строится во время запуска.
   - **Элемент исследования:** подтвердить, что нет runtime повторного чтения `modelProviders`
     (поиск конструкции content-generator / client). Ожидаемый результат: `false` — это скрытый баг; перевернуть в `true`.

2. **`permissions.*`: оставить hot-reloadable** (`settingsSchema.ts:1560`, всё
   поддерево в настоящее время `requiresRestart: true`)
   - Правила разрешений (`deny > ask > allow`) оцениваются при каждом вызове инструмента и
     предназначены быть настройками, которые пользователи больше всего хотят, чтобы вступали в силу немедленно.
   - Всё поддерево `permissions` — `showInDialog: false`, поэтому его
     флаг `requiresRestart` в настоящее время **не имеет значения UI** — сильный намёк, что
     `true` был значением по умолчанию, а не преднамеренным решением «требует перезапуска», поэтому
     blast radius переворачивания низок.
   - **Элемент исследования:** подтвердить, что runtime повторно читает разрешения в реальном времени (например, через
     `config.getXxx()` во время оценки), а не из снимка запуска. Если подтверждено, установить поддерево `permissions` в `requiresRestart: false`, чтобы
     оно **не** подавлялось механизмом повторного использования.

> Примечание: поскольку `requiresRestart` также отображается в UI настроек / подсказках перезапуска, переворачивание этих флагов изменяет это поведение тоже. Это приемлемо
> и, возможно, более правильно, но должно быть названо в описании PR.

### Приемка

- Изменение, касающееся только требующих перезапуска/чувствительных ключей (`security.auth.*`,
  `env`, `modelProviders`, `mcpServers`, `proxy`, …) emit'ит **нет**
  `SettingsChangeEvent`.
- Изменение hot-reloadable ключа (`ui.*`, `model.name`, `permissions.*` после
  переворачивания, …) всё ещё emit'ит событие.
- Смешанное изменение (один требующий перезапуска ключ + один hot-reloadable ключ) всё ещё emit'ит
  событие (hot-reloadable часть законно требует обновления).
- Изменение неизвестного (не-схемы) ключа всё ещё emit'ит, а не молча подавляется.

Статус теста:

- **Выполнено** — блок `restart-required suppression` в `settingsWatcher.test.ts`
  покрывает all-suppressed (`env`, `security.auth.apiKey`), all-allowed
  (`ui.Theme`), mixed и unknown-key случаи.
- **Ожидается (с переворачиваниями схемы)** — утверждения `settingsSchema.test.ts`
  фиксирующие два исправленных значения `requiresRestart`, и тест наблюдателя
  утверждающий, что `permissions.*` больше не подавляется после переворачивания.
