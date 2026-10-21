#!/usr/bin/env bash
# Загрузка данных из Finedog API для юнита 5224 (Коммуникационная платформа)
# Использование: ./update-units.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Определение корня репозитория через git или fallback на рабочую директорию
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="${REPO_ROOT}/.env"
DATA_FILE="/tmp/units_data.json"

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

echo "🔄 Обновление данных из Finedog API (юнит 5224)..."

# Получение токена
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Файл $ENV_FILE не найден. Запустите ./finedog-auth.sh"
    exit 1
fi

FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' "$ENV_FILE")

if [ -z "$FD_TOKEN" ]; then
    echo "❌ Токен не найден. Запустите ./finedog-auth.sh"
    exit 1
fi

# Получение данных из API
echo "📡 Получение данных из Finedog API (юнит 5224)..."
curl_with_retry -X POST \
  -H "Authorization: Bearer $FD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": [5224], "includeChildUnits": true, "page": 1, "pageSize": 1000}' \
  "https://finedog.tinkoff.ru/api/integration/v1/units/list" > "$DATA_FILE"

if [ ! -s "$DATA_FILE" ]; then
    echo "❌ Не удалось получить данные из API"
    exit 1
fi

# Генерация таблицы
echo "📝 Генерация service-catalog.md..."
python3 "${SCRIPT_DIR}/generate-service-catalog.py"

echo "✅ Service catalog обновлён!"
echo ""
echo "📊 Для обновления инцидентов выполните:"
echo "   python3 ${SCRIPT_DIR}/fetch-incidents.py"
echo "   python3 ${SCRIPT_DIR}/generate-table.py (если нужен полный отчёт)"
