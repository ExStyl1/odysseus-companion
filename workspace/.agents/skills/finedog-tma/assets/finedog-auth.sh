#!/bin/bash
set -e

# Определение корня репозитория (рабочая директория)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="${REPO_ROOT}/.env"

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

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Файл $ENV_FILE не найден"
    exit 1
fi

client_id=$(grep '^client_id=' "$ENV_FILE" | cut -d'=' -f2)
client_secret=$(grep '^client_secret=' "$ENV_FILE" | cut -d'=' -f2)

if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
    echo "❌ client_id или client_secret не найдены в $ENV_FILE"
    exit 1
fi

# Удаление старой строки token
grep -v '^token=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null && mv "$ENV_FILE.tmp" "$ENV_FILE" || true

# Получение нового токена
echo "🔐 Получение токена Finedog API..."
token_response=$(curl_with_retry -X POST \
  'https://finedog.tinkoff.ru/api/integration/v1/tokens/token' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=${client_id}&client_secret=${client_secret}")

access_token=$(echo "$token_response" | jq -r '.access_token // empty')

if [ -z "$access_token" ]; then
    echo "❌ Не удалось получить токен. Ответ API:"
    echo "$token_response" | jq .
    exit 1
fi

# Сохранение токена
echo "token=Bearer ${access_token}" >> "$ENV_FILE"
echo "✅ Токен успешно получен"

# Показываем информацию о токене
echo "📊 Информация о токене:"
echo "$token_response" | jq -r '"  Срок действия: " + (.expires_in | tostring) + " сек"'
