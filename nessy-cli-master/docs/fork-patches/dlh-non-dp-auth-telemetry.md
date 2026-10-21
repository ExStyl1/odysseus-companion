# dlh-non-dp-auth-telemetry

## AIDT

AIDT-7609

## Зачем

Сейчас события DLH отливаются только для пользователей с авторизацией
`dp-auth`. Более 1000 пользователей находятся в «серой зоне» — они выбрали
кастомную модель с кастомным ключом и обращаются к llm-proxy напрямую, в обход
nestor-backend. Эти пользователи не попадают в статистику DLH, даже если у них
есть валидный dp-auth аккаунт. Это штатная ситуация: агент может запускаться
в CI, где nestor-backend недоступен.

Патч расширяет DLH-отливку:

1. **Отправка для не-DP_AUTH (кастомная модель/ключ).** `sendDlhEvents`
   теперь резолвит токен не только из активной модели (DP_AUTH), но и через
   сохранённые dp-auth credentials (`getValidCredentials()?.jwt`), а при их
   отсутствии/истечении — логинит пользователя в dp-auth (`performNessyAuth`)
   и получает свежий токен.
2. **Очередь с ретраями.** События буферизуются и отправляются единым
   отправителем по таймеру (паттерн StatistClient). При сетевом сбое батч
   возвращается в очередь и досылается — события не теряются при моргающей
   сети. Очередь ограничена по количеству (100 событий) и по суммарному
   размеру payload (50 МБ); при переполнении дропаются самые старые.
3. **Отключение через конфиг.** Добавлена настройка `telemetry.dlhEnabled`
   (по аналогии с `statistEnabled`), чтобы в автоматизации/CI можно было
   полностью выключить DLH (запись, логин и отправку).
4. **Досылка при выходе.** `flushDlhQueue()` вызывается в
   `shutdownTelemetry()`, чтобы очередь не теряла события при завершении CLI
   (покрывает headless и serve-пути).

Недоступность бэкенда или отсутствие токена — не ошибка: события накапливаются
в очереди (в рамках лимита) и досылаются позже, либо отбрасываются при явном
отключении.

## Файлы

- `packages/core/src/telemetry/nessy-dlh/dlh-client.ts` — очередь с ретраями,
  `resolveDlhToken()` (fallback на dp-auth creds + `performNessyAuth`),
  `flushDlhQueue()`, `resetDlhAuthState()`.
- `packages/core/src/telemetry/nessy-dlh/index.ts` — реэкспорт `flushDlhQueue`.
- `packages/core/src/telemetry/index.ts` — реэкспорт `flushDlhQueue`.
- `packages/core/src/telemetry/sdk.ts` — `shutdownTelemetry()` флашит DLH-очередь
  параллельно с shutdown OTel SDK (`Promise.all`) под единым `SHUTDOWN_TIMEOUT_MS`;
  при неинициализированном OTel — тот же flush с тем же таймаутом (не блокировать
  выход при зависшей сети).
- `packages/core/src/config/config.ts` — настройка `telemetry.dlhEnabled`
  (`getTelemetryDlhEnabled()`), гейт `initNessyDlh`; `shutdown()` вызывает
  `shutdownTelemetry()` безусловно (без OTel-гейта), чтобы flush DLH-очереди
  срабатывал и при выключенном OTel.
- Тесты: `dlh-client.test.ts`, `config.test.ts`, `sdk.test.ts`.

Кодовые точки помечены `// [nessy-fork] dlh-non-dp-auth-telemetry`.

## Откат

1. В `dlh-client.ts` вернуть `sendDlhEvents` к однократной отправке без
   очереди, вернуть жёсткий гейт `authType === DP_AUTH`, убрать
   `resolveDlhToken`, `flushDlhQueue`, `resetDlhAuthState`, `_setDlhQueueSize`.
2. Убрать реэкспорт `flushDlhQueue` из `nessy-dlh/index.ts` и `telemetry/index.ts`.
3. В `sdk.ts` убрать вызов `flushDlhQueue()` из `shutdownTelemetry`.
4. В `config.ts` убрать `telemetry.dlhEnabled`, `getTelemetryDlhEnabled()`
   и вернуть безусловный `initNessyDlh(this)`.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Внутренняя телеметрия Tinkoff/T-Bank.
