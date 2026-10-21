# Аутентификация через делегированный токен (NESSY_CLI_DP_AUTH_TOKEN)

## Обзор

Nessy CLI поддерживает аутентификацию через делегированный JWT, переданный в переменной окружения `NESSY_CLI_DP_AUTH_TOKEN`. Это нужно для неинтерактивных сценариев, где невозможно открыть браузер для классического `dp auth login`.

Токен должен быть выпущен Spirit IAM по схеме OAuth 2.0 Token Exchange. Подробнее про сам процесс выпуска — в [документации Spirit IAM по token-exchange](https://devplatform.pages.devplatform.tcsbank.ru/spirit-integration-docs/docs/spirit-iam/how-tos/token-exchange/).

## Способы аутентификации

### 1. Интерактивная аутентификация (по умолчанию)

```bash
nessy "your query"
```

Открывается браузер для аутентификации пользователя через `dp auth login`.

### 2. Делегированный токен через NESSY_CLI_DP_AUTH_TOKEN

```bash
export NESSY_CLI_DP_AUTH_TOKEN="<your delegated jwt>"
nessy "your query"
```

При наличии `NESSY_CLI_DP_AUTH_TOKEN` в окружении CLI:

- Автоматически выбирает тип аутентификации `DP_AUTH` — диалог выбора не показывается.
- **Не запускает** `dp` бинарник и не открывает браузер.

#### Приоритет настроек

CLI выбирает auth type в порядке: явный флаг `--auth-type` → значение из `settings.json` (`security.auth.selectedType`) → переменная окружения. Это значит:

- Если запущено `nessy --auth-type openai ...` — `NESSY_CLI_DP_AUTH_TOKEN` игнорируется.
- Если в settings сохранён DP-AUTH или OpenAI — оно побеждает env.
- Если ничего явно не задано — `NESSY_CLI_DP_AUTH_TOKEN` автоматически активирует `DP_AUTH`.

## Troubleshooting

### Ошибка: `NESSY_CLI_DP_AUTH_TOKEN is invalid: ...`

**Причина:** значение в env не парсится как JWT (не три части, разделённые точками; либо payload не декодируется как JSON).

**Решение:**

- Проверьте, что переменная содержит ровно JWT, без префиксов вроде `Bearer `.
- Декодируйте payload вручную (`echo $NESSY_CLI_DP_AUTH_TOKEN | cut -d. -f2 | base64 -d`) и убедитесь, что внутри валидный JSON.

### Ошибка: `NESSY_CLI_DP_AUTH_TOKEN is expired`

**Причина:** `exp` в payload — в прошлом.

**Решение:**

- Запросите новый токен в Spirit IAM token-exchange.

### CLI всё равно открывает браузер

**Причина:** auth type был явно задан флагом или сохранён в settings, и побеждает env.

**Решение:**

- Удалите `--auth-type` из команды.
- Проверьте `~/.nessy/settings.json` и `.nessy/settings.json` в проекте — если там сохранён DP_AUTH без env-логики, удалите ключ `security.auth.selectedType` или установите `nessy_auth_type: dp-auth` в env, чтобы NESSY_CLI_DP_AUTH_TOKEN воспринимался.

## Примеры использования

### Базовое использование

```bash
# Интерактивная аутентификация
nessy "напиши тесты для src/utils.ts"

# Делегированный токен через env
NESSY_CLI_DP_AUTH_TOKEN="$DELEGATED_JWT" nessy "напиши тесты для src/utils.ts"
```

### Комбинирование с другими флагами

```bash
# С указанием модели
NESSY_CLI_DP_AUTH_TOKEN="$DELEGATED_JWT" nessy -m nessy-model "напиши тесты"

# В режиме отладки
NESSY_CLI_DP_AUTH_TOKEN="$DELEGATED_JWT" nessy -d "напиши тесты"
```

### Автоматизация в скриптах

```bash
#!/bin/bash

# Проверка наличия токена
if [ -z "$NESSY_CLI_DP_AUTH_TOKEN" ]; then
    echo "Error: NESSY_CLI_DP_AUTH_TOKEN environment variable is not set"
    exit 1
fi

# Запуск Nessy CLI
nessy "выполни задачу"
```
