---
name: "wixie-cli"
description: "Поиск Confluence по CQL и экспорт страниц в Markdown или PDF через dp wixie CLI."
when: "- Пользователь просит получить, скачать или экспортировать страницу из Confluence\n- Пользователь хочет найти страницы в Confluence по CQL-запросу\n- Пользователь упоминает Confluence, wiki или wixie\n- Пользователь даёт ссылку на wiki/Confluence-страницу и хочет получить её содержимое\n"
tags: ["wixie","confluence","wiki","cli","dp","spirit","export","cql","markdown","pdf"]
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# Wixie CLI — экспорт и поиск страниц Confluence через dp wixie

## Обзор

`dp wixie` — плагин Spirit CLI для выгрузки страниц из Confluence on-premise: экспорт в Markdown/PDF и поиск по CQL. Все
команды выполняются через Bash tool.

## Команды

### 1. Получение страниц — `get` (алиас: `g`)

Получение страниц из Confluence и вывод в stdout (по умолчанию) или сохранение в файлы.

```bash
dp wixie get --url <ссылка на страницу>
```

**Флаги:**

| Флаг          | Алиас | Описание                                                        | Обязательный | По умолчанию |
| ------------- | ----- | --------------------------------------------------------------- | ------------ | ------------ |
| `--url`       | `-u`  | URL страницы Confluence                                         | Да           | —            |
| `--output`    | `-o`  | Назначение вывода: `stdout` или `file`                          | Нет          | `stdout`     |
| `--format`    | `-f`  | Формат: `md` (Markdown) или `pdf`                               | Нет          | `md`         |
| `--recursive` | `-R`  | Рекурсивное извлечение дочерних страниц                         | Нет          | `false`      |
| `--structure` | —     | Сохранять дерево Confluence (работает только с `-o file`)       | Нет          | `false`      |
| `--overwrite` | `-O`  | Перезаписывать существующие файлы (работает только с `-o file`) | Нет          | `false`      |
| `--dir`       | `-d`  | Директория для сохранения (при `-o file`)                       | Нет          | `.`          |
| `--token`     | `-t`  | Токен авторизации (переопределяет `token_helper` из конфига)    | Нет          | —            |

**Примеры:**

Вывод страницы в stdout (Markdown):

```bash
dp wixie get --url https://wiki.example.com/spaces/SPACE/pages/PAGE_ID
```

Сохранение страницы в файл (PDF):

```bash
dp wixie get --url https://wiki.example.com/spaces/SPACE/pages/PAGE_ID -o file -f pdf -d ./docs
```

Рекурсивное получение с дочерними страницами:

```bash
dp wixie get --url https://wiki.example.com/spaces/SPACE/pages/PAGE_ID -R -o file -d ./docs
```

Сохранение с сохранением структуры дерева Confluence:

```bash
dp wixie get --url https://wiki.example.com/spaces/SPACE/pages/PAGE_ID -R -o file --structure -d ./output
```

Результат на диске:

```
output/
  Root.md
  Root/
    Child.md
    Child/
      Grand.md
```

С явной передачей токена:

```bash
dp wixie get --url https://wiki.example.com/spaces/SPACE/pages/PAGE_ID -t $(dp auth print-token)
```

**Имена файлов:** формируются из заголовка страницы (санитайз), например `System Router` → `System_Router.md`. При
коллизии имён добавляется суффикс `__<pageId>`. По умолчанию существующие файлы **не** перезаписываются — используйте
`--overwrite` для обновления.

---

### 2. Поиск страниц — `search` (алиас: `s`)

Поиск страниц в Confluence с помощью CQL (Confluence Query Language).

```bash
dp wixie search -q "<запрос>"
```

**Флаги:**

| Флаг       | Алиас | Описание                          | Обязательный | По умолчанию     |
| ---------- | ----- | --------------------------------- | ------------ | ---------------- |
| `--query`  | `-q`  | Текст поискового запроса          | Да           | —                |
| `--space`  | `-S`  | Ключ пространства Confluence      | Нет          | все пространства |
| `--limit`  | `-l`  | Макс. кол-во результатов          | Нет          | `25`             |
| `--format` | `-f`  | Формат вывода: `table` или `json` | Нет          | `table`          |
| `--token`  | `-t`  | Токен авторизации                 | Нет          | —                |

**Примеры:**

Поиск страниц по тексту:

```bash
dp wixie search -q "deployment guide"
```

Поиск в конкретном пространстве:

```bash
dp wixie search -q "API documentation" -S DEVSPACE
```

Ограничение результатов и вывод в JSON:

```bash
dp wixie search -q "release notes" -l 10 -f json
```

Передача JSON в jq:

```bash
dp wixie search -q "architecture" -f json | jq '.[].title'
```

Результат в формате `table` содержит: ID страницы, заголовок, ключ пространства и URL.

---

### 3. Интерактивный режим — `interactive` (алиас: `i`)

Интерактивный режим для просмотра страниц.

```bash
dp wixie interactive
```

---

### 4. Метаданные плагина — `print-metadata`

Вывод метаданных плагина в формате JSON (для интеграции с MCP и другим тулингом).

```bash
dp wixie print-metadata
```

---

## Справка и версия

```bash
dp wixie --help      # Вывод справки
dp wixie --version   # Вывод версии
```

## Аутентификация

Wixie использует **Spirit IAM токены**. Токен можно получить через Spirit CLI:

```bash
dp auth login
dp auth print-token
```

**Источники токена (в порядке приоритета):**

1. **CLI флаг** `--token` / `-t`
2. **Переменная окружения** `WIXIE_TOKEN`
3. **stdin** (JSON с полем `authorization_token` — при запуске как плагин Spirit CLI)
4. **Файл конфигурации** — команда `token_helper` из `config.toml`

Примеры:

```bash
# Через флаг
dp wixie get --url https://wiki.example.com/pages/123 -t $(dp auth print-token)

# Через переменную окружения
export WIXIE_TOKEN=$(dp auth print-token)
dp wixie get --url https://wiki.example.com/pages/123
```

## Конфигурация (TOML)

Файл конфигурации ищется в порядке: `$HOME/.wixie/config.toml` → `/etc/wixie/config.toml` → `./config.toml`. Если не
найден — создаётся в `$HOME/.wixie/config.toml`.

Пример `config.toml`:

```toml
[hosts]
[hosts."https://wiki.example.com"]
token_helper = "dp auth print-token"
removeSlug = true
```

- `token_helper` (обязательный) — команда для динамического получения токена
- `removeSlug` (опциональный) — убирает `/wiki/` из API-запросов для некоторых on-premise установок

Токены **никогда не хранятся** в файле конфигурации.

## Экспорт изображений

Wixie создаёт только ссылки на изображения в md-файлах. Для экспорта самих изображений:

1. Перейти в пространство → `Space tools > Content Tools`
2. Выбрать `Export` → `HTML` → `Next`
3. Выбрать `Normal Export` или `Custom Export`
4. Распаковать zip
5. Скопировать `./attachments` в целевую папку

## Правила использования

1. **Токен авторизации** — 4 источника в порядке приоритета: флаг `--token`/`-t` → `WIXIE_TOKEN` → stdin (плагин) →
   `config.toml` (`token_helper`)
2. **Для экономии токенов** используй формат `md` (по умолчанию) — Markdown компактнее PDF
3. **Для массового экспорта** используй `-R` (рекурсия) с `-o file` и `-d <директория>`
4. **Для сохранения иерархии** добавь `--structure` к рекурсивному экспорту
5. **Перезапись файлов** по умолчанию отключена — используй `--overwrite`/`-O`
6. **При ошибках** — проверь доступность `dp` CLI, валидность токена и ссылки на Confluence
7. **Извлечение URL**: если пользователь даёт ссылку вида `https://wiki.example.com/spaces/SPACE/pages/12345`, передай
   её целиком в `--url`
