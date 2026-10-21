---
title: 'Быстрый старт с DaemonClient (TypeScript)'
---

# Быстрый старт с DaemonClient (TypeScript)

Минимальный сквозной пример: запустите демон `nessy serve` в другом терминале, затем управляйте им из Node-скрипта с помощью `DaemonClient` из SDK. Смотрите также: [Руководство по режиму демона](../../../users/work/features/nessy-serve.md) и [Справочник по HTTP-протоколу](../../nessy-serve-protocol.md).

## Настройка

В одном терминале:

```bash
cd your-project/
nessy serve --port 4170
# → nessy serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/path/to/your-project)
```

Согласно [#3803](https://github.com/NessyLM/nessy-cli/issues/3803) §02 каждый демон привязывается к одному рабочему пространству при запуске (текущий `cwd`, или переопределите с `--workspace /path/to/dir`). Путь привязки демона объявляется в `/capabilities.workspaceCwd`, чтобы клиенты могли выполнить предварительную проверку и опустить `cwd` в `POST /session`.

В другом терминале:

```bash
npm install @nestor/nessy-cli-sdk
```

## Привет, демон

```ts
import { DaemonClient, type DaemonEvent } from '@nestor/nessy-cli-sdk';

const client = new DaemonClient({
  baseUrl: 'http://127.0.0.1:4170',
  // token: process.env.NESSY_SERVER_TOKEN, // требуется для привязок не на loopback
});

// 1. Убедитесь, что можем достичь демона, проверьте его возможности и
//    прочитайте привязанное рабочее пространство демона (#3803 §02).
const caps = await client.capabilities();
console.log('Возможности демона:', caps.features);
console.log('Рабочее пространство демона:', caps.workspaceCwd); // канонический путь привязки

// 2. Создание или прикрепление сессии. Две равнозначные формы:
//    (a) передайте `workspaceCwd: caps.workspaceCwd` для явности, или
//    (b) полностью опустите `workspaceCwd` — SDK тогда не отправит поле
//        `cwd`, и маршрут демона вернётся к привязанному рабочему пространству.
//    Форма (b) короче, но предполагает, что вы доверяете `caps.workspaceCwd`
//    как задуманному значению.
//    Непустой `workspaceCwd`, который не канонизируется к привязанному
//    пути демона, вернёт `400 workspace_mismatch` (смотрите «Несоответствие
//    рабочего пространства» ниже).
const session = await client.createOrAttachSession({
  workspaceCwd: caps.workspaceCwd,
});
console.log(`session=${session.sessionId} attached=${session.attached}`);

// 3. Подписка на поток событий. Передайте `lastEventId: 0`, чтобы демон
//    воспроизвёл всё с начала сессии — без этого существует окно TOCTOU
//    между возвратом итератора из `subscribeEvents()` и фактическим
//    открытием соединения SSE (один круг туда-обратно fetch), во время
//    которого быстро запускающийся агент может испустить события, которые
//    попадут в пер-сессийное кольцо, но не будут переданы свежему
//    подписчику без курсора. `lastEventId: 0` заставляет буфер
//    воспроизведения покрыть этот разрыв (и любое последующее
//    переподключение — смотрите ниже).
const abort = new AbortController();
const subscription = (async () => {
  for await (const event of client.subscribeEvents(session.sessionId, {
    signal: abort.signal,
    lastEventId: 0,
  })) {
    handleEvent(event);
  }
})();

// 4. Отправка промпта и ожидание завершения. (Примечание о порядке
//    операций: даже если `prompt()` срабатывает до завершения рукопожатия
//    SSE, `lastEventId: 0` из шага 3 гарантирует, что каждое событие
//    попадёт в итератор.)
const result = await client.prompt(session.sessionId, {
  prompt: [{ type: 'text', text: 'Обобщите src/main.ts в одном предложении.' }],
});
console.log('Причина остановки:', result.stopReason);

// 5. Завершение подписки, чтобы скрипт мог завершиться.
abort.abort();
await subscription;

function handleEvent(event: DaemonEvent): void {
  switch (event.type) {
    case 'session_update': {
      const data = event.data as {
        sessionUpdate: string;
        content?: { text?: string };
      };
      if (data.sessionUpdate === 'agent_message_chunk' && data.content?.text) {
        process.stdout.write(data.content.text);
      }
      break;
    }
    case 'permission_request':
      // Смотрите «Голосование по разрешениям» ниже для семантики первого ответившего.
      console.log('\n[требуется разрешение]', event.data);
      break;
    case 'permission_resolved':
      console.log('\n[разрешение получено]', event.data);
      break;
    case 'session_died':
      console.error('\n[агент упал]', event.data);
      break;
    default:
      console.log(`\n[${event.type}]`, event.data);
  }
}
```

## Вспомогательные методы для работы с файлами

Маршруты для работы с файлами имеют область видимости рабочего пространства, а не сессии, поэтому они находятся непосредственно на `DaemonClient`:

```ts
const file = await client.readWorkspaceFile('src/main.ts');

const updated = await client.editWorkspaceFile({
  path: 'src/main.ts',
  oldText: 'timeout: 30000',
  newText: 'timeout: 60000',
  expectedHash: file.hash!,
});

console.log(updated.hash);
```

`expectedHash` — это SHA-256 от сырых байтов на диске. `mode: "replace"` и `editWorkspaceFile()` требуют его, чтобы устаревшие клиенты не перезаписали файл, который они только что не читали. Запись и редактирование требуют конфигурации с bearer-токеном даже на loopback; запускайте демон с `--token` или `NESSY_SERVER_TOKEN` перед их использованием.

## Переподключение с `Last-Event-ID`

Если ваш клиентский процесс перезапускается в середине сессии, воспроизведите пропущенные события:

```ts
let cursor: number | undefined;

for await (const event of client.subscribeEvents(session.sessionId, {
  signal: abort.signal,
  lastEventId: cursor, // возобновить после этого id; undefined = только live
})) {
  if (typeof event.id === 'number') cursor = event.id;
  handleEvent(event);
}
```

Демон хранит последние 4000 событий на сессию в кольцевом буфере; разрывы за пределами этого окна не смогут быть повторно доставлены.

## Голосование по разрешениям

Когда агент запрашивает разрешение на выполнение инструмента, каждый подключённый клиент видит событие `permission_request`. **Первый ответивший побеждает** — как только один клиент голосует, остальные получают `404`, если пытаются проголосовать по тому же `requestId`.

```ts
case 'permission_request': {
  const req = event.data as {
    requestId: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
  // Выберите любой вариант — `proceed_once`, `allow` и т.д.
  const choice = req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
  const accepted = await client.respondToPermission(req.requestId, {
    outcome: { outcome: 'selected', optionId: choice.optionId },
  });
  if (!accepted) {
    console.log('Другой клиент проголосовал первым; ничего делать не нужно.');
  }
  break;
}
```

## Совместная работа с общей сессией

Два клиента, направленных на **один и тот же демон**, оказываются на одной сессии. Согласно #3803 §02 каждый демон привязан к ОДНОМУ рабочему пространству при запуске, поэтому демон, запущенный как `nessy serve --workspace /work/repo` (или `cd /work/repo && nessy serve`), — это то, к чему подключаются оба клиента:

```ts
// Демон был запущен как `nessy serve --workspace /work/repo`, поэтому
// `caps.workspaceCwd === '/work/repo'` для обоих клиентов.

// Клиент A (например, плагин IDE)
const a = await clientA.createOrAttachSession({ workspaceCwd: '/work/repo' });
console.log(a.attached); // false — A создал агента

// Клиент B (например, веб-UI на той же машине)
const b = await clientB.createOrAttachSession({ workspaceCwd: '/work/repo' });
console.log(b.attached); // true — B присоединился к сессии A
console.log(a.sessionId === b.sessionId); // true
```

Оба клиента видят один и тот же поток `session_update` / `permission_request`. Любой может отправить промпт; они ставятся в очередь FIFO согласно гарантии агента «один активный промпт на сессию».

## Несоответствие рабочего пространства

Если `workspaceCwd` не совпадает с привязанным рабочим пространством демона, `createOrAttachSession` отклоняет запрос с `DaemonHttpError`, содержащим статус `400` и структурированное тело:

```ts
import { DaemonHttpError } from '@nestor/nessy-cli-sdk';

try {
  await client.createOrAttachSession({ workspaceCwd: '/some/other/project' });
} catch (err) {
  if (err instanceof DaemonHttpError && err.status === 400) {
    const body = err.body as {
      code?: string;
      boundWorkspace?: string;
      requestedWorkspace?: string;
    };
    if (body.code === 'workspace_mismatch') {
      console.error(
        `Этот демон привязан к ${body.boundWorkspace}, ` +
          `а не к ${body.requestedWorkspace}. Запустите отдельный демон ` +
          `для этого рабочего пространства или направьте запрос к нужному.`,
      );
    }
  }
}
```

Развёртывания с несколькими рабочими пространствами запускают по одному демону на рабочее пространство на отдельных портах — внутриденной маршрутизации в §02 нет. Оркестратор (или лаунчер пользователя) выбирает правильный демон на основе проекта, с которым клиент хочет работать.

## Аутентификация

Когда демон был запущен с токеном (любая привязка не на loopback требует его):

```ts
const client = new DaemonClient({
  baseUrl: 'https://your-host:4170',
  token: process.env.NESSY_SERVER_TOKEN,
});
```

**Резервное чтение переменной окружения SDK (PR 27, v0.16-alpha).** Если `token` не задан, `DaemonClient` автоматически читает `NESSY_SERVER_TOKEN` из окружения, повторяя поведение CLI-флага демона `--token`. Поэтому при выполненном в shell `export NESSY_SERVER_TOKEN=...` следующий вариант эквивалентен предыдущему:

```ts
// То же действие, что token: process.env.NESSY_SERVER_TOKEN, но без шаблонного кода.
const client = new DaemonClient({ baseUrl: 'https://your-host:4170' });
```

Резервный механизм удаляет начальные и конечные пробелы (это удобно для `export NESSY_SERVER_TOKEN="$(cat token.txt)"`, где `cat` добавляет перевод строки) и считает пустые либо состоящие только из пробелов значения отсутствующими: устаревший `export NESSY_SERVER_TOKEN=""` не приведёт к отправке пустого `Authorization: Bearer `. Значение читается один раз при создании клиента; последующие изменения `process.env` не влияют на уже созданные клиенты. В браузерных сборках (например, через `@nestor/nessy-cli-webui`) корректно получается `undefined`, поскольку там отсутствует `globalThis.process`.

Неправильные / отсутствующие токены возвращают `401` с унифицированным телом — SDK выбрасывает `DaemonHttpError` при любом 4xx/5xx от обработчика маршрута.

```ts
import { DaemonHttpError } from '@nestor/nessy-cli-sdk';

try {
  await client.health();
} catch (err) {
  if (err instanceof DaemonHttpError) {
    console.error(`Ошибка демона ${err.status}:`, err.body);
  } else {
    throw err;
  }
}
```

## Отмена активного промпта

Если пользователь нажал Esc:

```ts
await client.cancel(session.sessionId);
// В потоке событий вы увидите, что промпт завершился с stopReason: "cancelled"
```

Отмена завершает только **активный** промпт — всё, что вы уже отправили через POST и что всё ещё находится в очереди позади него, продолжит выполняться. (Смотрите справочник по протоколу для обоснования.)

## Что дальше

- [Справочник по HTTP-протоколу](../../nessy-serve-protocol.md) — полная спецификация маршрутов с кодами статусов
- [Руководство по режиму демона](../../../users/work/features/nessy-serve.md) — документация для операторов
- Исходный код: `packages/sdk-typescript/src/daemon/`
