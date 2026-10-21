#!/bin/sh

# Скрипт обновления OpenAPI спецификаций Finedog API
# Использует токен из .env (в корне репозитория) для авторизации

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(pwd)"

OPENAPI_DIR="$SCRIPT_DIR/openapi"
ENV_FILE="$REPO_ROOT/.env"

# Параметры retry для обработки HTTP 429
MAX_RETRIES=5
RETRY_DELAY=1  # начальная задержка в секундах

# Функция для выполнения curl с retry при HTTP 429
curl_with_retry() {
    local retry_count=0
    local delay=$RETRY_DELAY
    local response
    local http_code
    
    while [ $retry_count -lt $MAX_RETRIES ]; do
        # Выполняем запрос, получаем HTTP код и тело ответа
        response=$(curl -s -w "\n%{http_code}" "$@")
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')
        
        if [ "$http_code" = "429" ]; then
            retry_count=$((retry_count + 1))
            if [ $retry_count -lt $MAX_RETRIES ]; then
                echo "⚠️  HTTP 429 (Too Many Requests). Попытка $retry_count/$MAX_RETRIES. Ожидание ${delay}с..."
                sleep $delay
                # Экспоненциальная задержка
                delay=$((delay * 2))
                continue
            else
                echo "❌ Превышено максимальное количество попыток ($MAX_RETRIES) из-за HTTP 429"
                return 1
            fi
        elif [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
            echo "$body"
            return 0
        else
            echo "$body"
            return 0
        fi
    done
    
    echo "$body"
    return 0
}

# Проверяем наличие токена
if ! grep -q "^token=Bearer " "$ENV_FILE"; then
    echo "Ошибка: токен не найден в $ENV_FILE"
    echo "Сначала выполните: ./finedog-auth.sh"
    exit 1
fi

# Извлекаем токен
FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' "$ENV_FILE")

echo "Обновление OpenAPI спецификаций Finedog API..."

# Создаём директорию если не существует
mkdir -p "$OPENAPI_DIR"

# Список спецификаций (из index.js: configObject)
# https://finedog.tinkoff.ru/api/integration/swagger/index.js
# v1
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/v1/swagger.json" \
    -o "$OPENAPI_DIR/v1.json"
# catalog
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/catalog/integration/swagger.json" \
    -o "$OPENAPI_DIR/catalog.json"
# core
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/core/integration/swagger.json" \
    -o "$OPENAPI_DIR/core.json"
# event-triggers
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/event-triggers/integration/swagger.json" \
    -o "$OPENAPI_DIR/event-triggers.json"
# identity
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/identity/integration/swagger.json" \
    -o "$OPENAPI_DIR/identity.json"
# releases
curl_with_retry -s -H "Authorization: Bearer $FD_TOKEN" \
    "https://finedog.tinkoff.ru/api/integration/swagger/releases/integration/swagger.json" \
    -o "$OPENAPI_DIR/releases.json"

for spec in v1.json catalog.json core.json event-triggers.json identity.json releases.json; do

    if [ -s "$OPENAPI_DIR/$spec" ]; then
        echo "    ✓ $spec обновлён"
    else
        echo "    ✗ Ошибка загрузки $spec"
        rm -f "$OPENAPI_DIR/$spec"
    fi
done

echo "Готово!"
