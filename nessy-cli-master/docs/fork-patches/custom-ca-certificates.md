# custom-ca-certificates

## AIDT

AIDT-8375

## Зачем

CLI должен доверять корпоративным CA при запуске, даже если их нет в системном
хранилище. Позднее присваивание `NODE_EXTRA_CA_CERTS` не добавляет сертификаты
в текущий Node-процесс, поэтому bootstrap отдельно настраивает доверие для
него и окружение для дочерних процессов.

## Как сертификаты попадают в bundle

Скачивание, проверка и упаковка дополнительного Russian Root CA описаны
в [statist-trusted-ca](./statist-trusted-ca.md).

1. `npm run bundle` из корня проекта сначала запускает
   `scripts/download-certs.js`. Скрипт скачивает в корневой `certs/`
   `tinkoff-bundle.crt` из
   `https://ca-certs.tcsbank.ru/v0/tinkoff-bundle.crt` и `russian-root-ca.crt`
   из `https://ca-certs.tcsbank.ru/v0/russian-root-ca.crt`.
2. Проверяются PEM-сертификаты основного bundle и закреплённый SHA-256
   fingerprint Russian Root CA. Если оба локальных файла уже есть и проходят
   проверку, скачивание пропускается. Новые файлы сначала записываются во
   временные `.tmp`, затем переименовываются. Ошибка скачивания или проверки
   останавливает сборку.
3. Далее `esbuild.config.js` собирает CLI с
   `NODE_EXTRA_CA_CERTS=certs/tinkoff-bundle.crt`, а
   `scripts/copy_bundle_assets.js` копирует каталог `certs/` в `dist/certs/`.
   Сертификаты поставляются отдельными файлами рядом с `dist/cli.js`; при
   запуске bootstrap находит их в `certs/` относительно каталога модуля.
4. При упаковке standalone `scripts/create-standalone-package.js` требует
   наличия обоих CA-файлов в `dist/certs/` и копирует их в
   `nessy-cli/lib/certs/` внутри архива, рядом с `nessy-cli/lib/cli.js`.

## Использование при запуске

Поиск файлов и обновление кэша описаны в
[desktop-first-run-setup](./desktop-first-run-setup.md), а добавление CA
в TLS-контексты текущего процесса — в
[macos-internal-seatbelt-profile](./macos-internal-seatbelt-profile.md).

Логика в `packages/cli/src/bootstrap.ts`:

1. При импорте модуля вызывается `ensureExtraCaCert()`. Загрузка CA включена
   по умолчанию; её отключают `NESSY_USE_BUNDLED_CA=false` или
   `security.ca.useBundledCa: false` в `.nessy/settings.json`. Настройка
   проекта имеет приоритет над `~/.nessy/settings.json`. Отключение через
   settings также записывает `NESSY_USE_BUNDLED_CA=false` в окружение.
2. Ищутся `tinkoff-bundle.crt` и `russian-root-ca.crt` в `certs`,
   `../../../certs` и `../../../../certs` относительно каталога модуля.
   Выбираются найденные файлы из первого подходящего каталога — для bundle,
   запуска из исходников или TypeScript-сборки.
3. Найденные файлы копируются в `~/.nessy/certs` с перезаписью кэша.
   Ошибка записи кэша не мешает использовать файлы из поставки. Если файлы
   из поставки не найдены, используются существующие файлы из кэша.
4. Уже заданный `NODE_EXTRA_CA_CERTS` сохраняется. Если переменная не задана,
   в неё записывается путь к первому выбранному CA-файлу; все выбранные файлы
   отдельно применяются в текущем процессе.
5. Из выбранных файлов извлекаются все PEM-блоки сертификатов.
   `trustExtraCaCertInCurrentProcess()` один раз оборачивает
   `tls.createSecureContext` и добавляет их через `addCACert` к новым
   контекстам со стандартным доверием. Контексты с явно заданным `ca`
   остаются без изменений. При отсутствии PEM-блоков обёртка не ставится.
6. Ошибки настройки сертификатов не блокируют запуск CLI.

## Файлы

- `packages/cli/src/bootstrap.ts`

## Откат

1. Удалить автоматический вызов `ensureExtraCaCert()` и загрузку, кэширование
   и настройку bundled CA в bootstrap, если upstream покрывает это поведение.
2. Удалить обёртку `tls.createSecureContext`, заменив её эквивалентным
   upstream-механизмом доверия для текущего процесса.
3. Проверить сохранение поведения зависимых патчей `statist-trusted-ca`,
   `desktop-first-run-setup` и `macos-internal-seatbelt-profile`.
4. Удалить маркер `[nessy-fork] custom-ca-certificates`, строку реестра
   и этот файл.

## Upstream

Не отправлен. Используются корпоративные CA из поставки Nessy.
