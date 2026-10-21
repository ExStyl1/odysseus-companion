# nessy-async

Docker-образ для запуска `nessy-cli` в автономном (headless) режиме — выполняет набор промптов без интерактивного ввода.

## Требования

- Docker
- `DP_TOKEN` — токен DevPlatform

## Быстрый старт

```bash
# Пул готового образа
docker pull docker-hosted.artifactory.tcsbank.ru/nestor/nessy-async:latest

# Запуск
docker run --rm -e DP_TOKEN="$DP_TOKEN" docker-hosted.artifactory.tcsbank.ru/nestor/nessy-async:latest
```

## Сборка локально

```bash
# Сборка
docker build -f async.Dockerfile -t nessy-async .

# Запуск
docker run --rm -e DP_TOKEN="$DP_TOKEN" nessy-async
```

## Промпты

Промпты хранятся в файле `deploy/async/prompts.txt` и запекаются в образ при сборке.

При запуске весь файл передаётся одним вызовом `nessy -y -p`.

### Подменить файл промптов без пересборки

```bash
docker run --rm \
  -e DP_TOKEN="$DP_TOKEN" \
  -v /path/to/my-prompts.txt:/prompts.txt \
  nessy-async
```

### Указать другой путь к файлу

```bash
docker run --rm \
  -e DP_TOKEN="$DP_TOKEN" \
  -e PROMPTS_FILE=/custom/path/prompts.txt \
  -v /path/to/my-prompts.txt:/custom/path/prompts.txt \
  nessy-async
```

## Конфигурация

Настройки nessy хранятся в `deploy/async/.nessy/` и запекаются в образ по пути `/root/.nessy/`.

### Модель

`settings.json` → `model.name`: `tgpt/qwen3-next-80b-a3b-instruct`

### Подключённые MCP-серверы

| Сервер   | Команда                     | Назначение             |
| -------- | --------------------------- | ---------------------- |
| jira     | `dp ai mcp jira`            | Задачи в Jira          |
| gitlab   | `dp ai mcp gitlab`          | GitLab API             |
| dpWiki   | `dp ai mcp wixie`           | Внутренняя wiki        |
| context7 | `npx @upstash/context7-mcp` | Документация библиотек |
| docforge | `npx @system-analysis/mcp`  | Чтение страниц wiki    |

### Использование MCP в промпте

```
Предоставь краткое описание страницы https://... Используй docforge
Настрой скрипт Cloudflare Worker для кэширования JSON API. Используй context7
```

## CI/CD

Образ собирается автоматически при изменениях в `async.Dockerfile` или `deploy/async/**`:

- **feature-ветка** → тег `<commit-sha>`
- **master** → тег `latest`
