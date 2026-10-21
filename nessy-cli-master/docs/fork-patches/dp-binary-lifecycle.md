# dp-binary-lifecycle

## AIDT

- AIDT-6860
- AIDT-8228

## Зачем

Managed-бинарь `dp` в `<NESSY_HOME>/dp_latest/` — единственная точка входа для
bundled dp MCP-серверов (`dpWiki`, `codeSearch`, `dpJira`, …) и для DP Auth.
Upstream-механизма его установки нет: и загрузка, и самообновление, и проверка
пригодности — целиком форк.

Установка сделана атомарной. Загрузка идёт во временный файл рядом с целевым,
там же сверяется md5 и выставляется бит запуска, и только полностью проверенный
файл попадает на боевой путь через `rename`. Прежняя схема писала стримом сразу
в `dp_latest/dp`, а контрольная сумма проверялась только внутри ветки «файла
нет» — оборванная загрузка оставляла обрезанный бинарь, который на следующем
запуске считался существующим и уже никогда не перепроверялся.

Пригодность существующего бинаря определяется его фактическим запуском
(`dp --version`), а не контрольной суммой: после `dp update` бинарь
самообновляется, и pinned-md5 к нему неприменим по построению. Контрольная сумма
проверяется исключительно на свежескачанном файле, где обязана совпасть.

`dp update` больше не блокирует старт: наличие новой версии проверяется в фоне
голой командой `dp` (маркер `dp update available from X to Y`), а само обновление
инициируется асинхронно и не держит `initializeApp`. Сбой запуска бинаря
трактуется как признак повреждения и приводит к переустановке.

dp печатает маркер обновления только когда stdout — интерактивный терминал
(TTY); из неинтерактивного подпроцесса он молчит. Поэтому фоновая проверка
`checkForDpUpdateAvailable()` запускает голый `dp` под **PTY** через `node-pty`
(`getPty`), захватывает вывод и парсит версии. Пользователю ничего не
показывается напрямую — уведомление (с версиями `X → Y`) идёт через
`updateEventEmitter` → TUI-тост. Если PTY недоступен (например Windows) —
fallback на обычный запуск без маркера.

Уведомления о доступности новой версии, об успехе и об ошибке обновления
локализованы: сообщения формируются через общий CLI i18n-механизм
(`t(key, params)`), переводы добавлены в `en.js`/`ru.js`. Текст успеха сообщает,
что новая версия dp доступна сразу — без перезапуска nessy (в отличие от
обновления самого nessy, которому нужен рестарт).

### Костыль: direct-download fallback (dp-update-fallback-workaround)

`dp update` (самообновление самого бинаря) на части сетей не срабатывает даже
когда прямой download-URL доступен — команда либо сдаётся сама, либо не
укладывается в таймаут, оставляя pinned-бинарь на месте. Это костыль: при сбое
`dp update` фоновая проверка скачивает ту же версию напрямую с S3-эндпоинта
(`installDpVersion`), проверяет, что бинарь реально запускается, и атомарно
заменяет его. Проверка контрольной суммы для произвольной (новой) версии
отсутствует — ограничиваемся фактическим запуском.

**Удалить**, когда `dp update` начнёт работать на таких сетях. Маркеры:
`// [nessy-fork] dp-update-fallback-workaround` в `dp-downloader.ts` и
`dp-update-background.ts`; вызов `installDpVersion(info.latest)` в
`runBackgroundCheck`.

Установка бинаря вынесена в начало `initializeApp` и не зависит от типа
авторизации. Привязать её к auth нельзя: forced auth выходит раньше при наличии
кэшированных кред, а они лежат в `oauth_creds.json` — вне `dp_latest/`. На
машине с сохранённой авторизацией, но без бинаря MCP-серверы падали с `ENOENT`.

Вызовы `dp` переведены с `exec` на `execFile` с массивом аргументов: путь не
экранировался, и `NESSY_HOME` с пробелом ломал команду.

## Файлы

- `packages/cli/src/core/dp-update-background.ts`
- `packages/cli/src/core/dp-update-background.test.ts`
- `packages/cli/src/core/dpBinary.ts`
- `packages/cli/src/core/initializer.test.ts`
- `packages/cli/src/core/initializer.ts`
- `packages/cli/src/gemini.tsx`
- `packages/cli/src/i18n/locales/en.js`
- `packages/cli/src/i18n/locales/ru.js`
- `packages/cli/src/nonInteractiveCli.ts`
- `packages/cli/src/serve/run-nessy-serve.ts`
- `packages/core/src/dp/dp-api.ts`
- `packages/core/src/dp/dp-config.ts`
- `packages/core/src/dp/dp-downloader.test.ts`
- `packages/core/src/dp/dp-downloader.ts`
- `packages/core/src/dp/dp-updater.test.ts`
- `packages/core/src/dp/dp-updater-check.test.ts`
- `packages/core/src/dp/dp-updater.ts`

Кодовые точки помечены `// [nessy-fork] dp-binary-lifecycle` (и, для костыля,
`// [nessy-fork] dp-update-fallback-workaround`).

## Откат

1. Убрать маркеры `dp-binary-lifecycle`.
2. Удалить `packages/cli/src/core/dpBinary.ts` и вызов `ensureDpBinary()` из
   `initializeApp`, если upstream гарантирует наличие бинаря до старта MCP.
3. Вернуть неатомарную загрузку и проверку по контрольной сумме вместо запуска
   `dp --version`, только если upstream обеспечивает эквивалентную защиту от
   обрезанного бинаря и учитывает самообновление.
4. **Убрать костыль** `dp-update-fallback-workaround` (маркеры и вызов
   `installDpVersion`), как только `dp update` начнёт работать на всех сетях.
5. Убрать фоновую проверку/обновление (`startBackgroundDpUpdate`,
   `checkForDpUpdateAvailable`, PTY-детекцию), если upstream перенесёт
   неблокирующее самообновление dp на свой механизм.
6. Убрать i18n-переводы уведомлений dp из `en.js`/`ru.js`, если сообщения
   вернутся к upstream-текстам.
7. Удалить или адаптировать регрессионные тесты `dp-downloader.test.ts` и
   `dp-updater.test.ts`, а также `dp-update-background.test.ts`.
8. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
