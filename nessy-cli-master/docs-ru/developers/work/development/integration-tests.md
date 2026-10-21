---
title: Интеграционные тесты
---

# Интеграционные тесты

В этом документе описана инфраструктура интеграционного тестирования проекта.

## Обзор

Интеграционные тесты проверяют сквозную работу Nessy CLI. Они запускают собранный исполняемый файл в контролируемом окружении и проверяют ожидаемое поведение при взаимодействии с файловой системой.

Тесты находятся в каталоге `integration-tests` и запускаются специальным тестовым runner.

## Запуск тестов

Интеграционные тесты не входят в стандартную команду `npm run test`. Их нужно запускать явно скриптом `npm run test:integration:all`.

Для быстрой локальной отладки также доступен вспомогательный скрипт:

```bash
npm run test:e2e
```

В отличие от обычных интеграционных скриптов, `test:e2e` включает `KEEP_OUTPUT=true` и `VERBOSE=true`, поэтому вывод тестов сохраняется и транслируется в консоль.

## Доступные скрипты

В репозитории доступны следующие скрипты интеграционного тестирования:

- `npm run test:integration:all` — запускает полную матрицу песочниц (`none`, `docker`, `podman`);
- `npm run test:integration:sandbox:none` — запускает весь набор интеграционных тестов без песочницы;
- `npm run test:integration:sandbox:docker` — запускает весь набор с песочницей Docker;
- `npm run test:integration:sandbox:podman` — запускает весь набор с песочницей Podman;
- `npm run test:integration:cli:sandbox:none` — запускает только интеграционные тесты CLI, исключая `integration-tests/sdk-typescript`;
- `npm run test:integration:sdk:sandbox:none` — запускает только интеграционные тесты TypeScript SDK из `integration-tests/sdk-typescript`;
- `npm run test:e2e` — сокращённая отладочная команда для `test:integration:sandbox:none` с подробным журналом и сохранением артефактов.

В CI ручная задача `test_integration` сейчас выполняет `npm run test:integration:sandbox:none`.

## Запуск выбранных тестов

Для запуска поднабора файлов используйте `npm run <integration test command> <file_name1> ...`, где &lt;integration test command&gt; — `test:e2e` или `test:integration*`, а `<file_name>` — имя любого файла `.test.ts` в каталоге `integration-tests/`. Например, следующая команда запускает `list_directory.test.ts` и `write_file.test.ts`:

```bash
npm run test:e2e list_directory write_file
```

### Запуск одного теста по имени

Используйте флаг `--test-name-pattern`:

```bash
npm run test:e2e -- --test-name-pattern "reads a file"
```

### Запуск всех тестов

Чтобы запустить весь набор интеграционных тестов, выполните:

```bash
npm run test:integration:all
```

### Матрица песочниц

Команда `all` запускает тесты без песочницы, с Docker и с Podman. Каждый вариант можно запустить отдельно:

```bash
npm run test:integration:sandbox:none
```

```bash
npm run test:integration:sandbox:docker
```

```bash
npm run test:integration:sandbox:podman
```

## Диагностика

Runner интеграционных тестов предоставляет несколько средств диагностики сбоев.

### Сохранение вывода тестов

Для анализа можно сохранить временные файлы, созданные во время теста. Это особенно полезно при отладке операций с файловой системой.

Установите переменную окружения `KEEP_OUTPUT` в `true`:

```bash
KEEP_OUTPUT=true npm run test:integration:sandbox:none
```

При сохранении вывода runner печатает путь к уникальному каталогу запуска.

### Подробный вывод

Для расширенной диагностики установите `VERBOSE=true`:

```bash
VERBOSE=true npm run test:integration:sandbox:none
```

Если одновременно заданы `VERBOSE=true` и `KEEP_OUTPUT=true`, вывод транслируется в консоль и сохраняется в файл журнала во временном каталоге теста.

Подробный вывод содержит явные границы источника журнала:

```
--- TEST: <log dir>:<test-name> ---
... output from the nessy command ...
--- END TEST: <log dir>:<test-name> ---
```

## Линтинг и форматирование

Файлы интеграционных тестов проверяются линтером в рамках основного процесса сборки. Линтер и автоисправление можно запустить вручную.

### Запуск линтера

Проверка ошибок:

```bash
npm run lint
```

Автоматическое исправление доступных проблем:

```bash
npm run lint:fix
```

## Структура каталогов

Для каждого запуска интеграционные тесты создают уникальный каталог внутри `.integration-tests`. В нём создаётся подкаталог для каждого тестового файла, а внутри — отдельный каталог для каждого тестового случая.

Такая структура упрощает поиск артефактов конкретного запуска, файла или тестового случая.

```
.integration-tests/
└── <run-id>/
    └── <test-file-name>.test.ts/
        └── <test-case-name>/
            ├── output.log
            └── ...other test artifacts...
```

## Непрерывная интеграция

Чтобы интеграционные тесты выполнялись регулярно, в `.github/workflows/e2e.yml` определён workflow GitHub Actions. Он автоматически запускается для merge request в ветку `main` и при добавлении merge request в очередь слияния.

Workflow проверяет Nessy CLI в разных окружениях песочницы:

- `sandbox:none` — без песочницы;
- `sandbox:docker` — в контейнере Docker;
- `sandbox:podman` — в контейнере Podman.
