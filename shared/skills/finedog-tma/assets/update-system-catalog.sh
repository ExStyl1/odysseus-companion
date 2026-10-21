#!/usr/bin/env bash
set -euo pipefail

# Обновление system-catalog.md — таблицы систем/компонентов (юниты 3274 и 45461)
# Запускает обновление данных из API и генерацию таблицы

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"
DATA_FILE="/tmp/units_data.json"
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

echo "🔄 Обновление system-catalog.md..."

# 1. Обновление данных из API для юнитов 3274 и 45461
FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' "$ENV_FILE")

if [[ -z "$FD_TOKEN" ]]; then
    echo "❌ Токен не найден. Запустите ./finedog-auth.sh"
    exit 1
fi

echo "📡 Загрузка данных из Finedog API (юниты 3274, 45461)..."
curl_with_retry -X POST \
  -H "Authorization: Bearer $FD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": [3274, 45461], "includeChildUnits": true, "page": 1, "pageSize": 1000}' \
  "https://finedog.tinkoff.ru/api/integration/v1/units/list" > "$DATA_FILE"

if [[ ! -s "$DATA_FILE" ]]; then
    echo "❌ Не удалось получить данные из API"
    exit 1
fi

# 2. Загрузка кэша команд (если нет)
if [[ ! -f "$SCRIPT_DIR/teams_cache.json" ]]; then
    echo "👥 Загрузка кэша команд..."
    python3 "$SCRIPT_DIR/fetch-teams.py"
fi

# 3. Генерация таблицы
echo "📊 Генерация system-catalog.md..."
python3 "$SCRIPT_DIR/generate-system-catalog.py"

echo "✅ System catalog обновлён!"
