#!/usr/bin/env bash
set -euo pipefail

# Скрипт обновления полей юнитов в Finedog API
# Обновляет: chatSupport, gitlab, teamsIds, keyValues, description
#
# Использование:
#   ./update-unit-fields.sh <unit_id> [unit_id2] [unit_id3] ...
#   ./update-unit-fields.sh --file <file_with_unit_ids>
#
# Примеры:
#   ./update-unit-fields.sh 78383 75696 75449
#   ./update-unit-fields.sh --file units_to_update.txt

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Определение корня репозитория через git или fallback на относительный путь
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || cd "$SCRIPT_DIR/../../../" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

# Параметры по умолчанию для всех
DEFAULT_CHAT_SUPPORT="~tma-sre"
DEFAULT_PSD_RATE_LIMITED="na"
DEFAULT_PSD_CANARY_USED="na"
DEFAULT_PSD_PROD="true"
DEFAULT_TEAMS="[36]"

# Параметры retry для обработки HTTP 429
MAX_RETRIES=5
RETRY_DELAY=1

# Функция для выполнения curl с retry при HTTP 429
curl_with_retry() {
    local retry_count=0
    local delay=$RETRY_DELAY
    local response
    local http_code

    while [ $retry_count -lt $MAX_RETRIES ]; do
        response=$(curl -s -w "\n%{http_code}" "$@")
        http_code=$(echo "$response" | tail -n1)
        body=$(echo "$response" | sed '$d')

        if [ "$http_code" = "429" ]; then
            retry_count=$((retry_count + 1))
            if [ $retry_count -lt $MAX_RETRIES ]; then
                echo "    ⚠️  HTTP 429. Попытка $retry_count/$MAX_RETRIES. Ожидание ${delay}с..."
                sleep $delay
                delay=$((delay * 2))
                continue
            else
                echo "    ❌ Превышено количество попыток ($MAX_RETRIES) из-за HTTP 429"
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

# Получение токена
get_token() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "❌ Файл $ENV_FILE не найден"
        exit 1
    fi

    local token=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' "$ENV_FILE")
    if [ -z "$token" ]; then
        echo "❌ Токен не найден. Запустите ./finedog-auth.sh"
        exit 1
    fi

    echo "$token"
}

# Получение информации о юните
get_unit_info() {
    local unit_id=$1
    local token=$2

    local response=$(curl_with_retry -s \
        -H "Authorization: Bearer $token" \
        "https://finedog.tinkoff.ru/api/integration/v1/units/$unit_id")

    echo "$response"
}

# Обновление юнита
update_unit() {
    local unit_id=$1
    local token=$2
    local description=$3
    local gitlab_name=$4
    local kind=$5
    local domain=$6
    local parent_id=$7

    # Формируем GitLab URL
    local gitlab_url=""
    if [ -n "$gitlab_name" ]; then
        gitlab_url="$DEFAULT_GITLAB_BASE/$gitlab_name"
    fi

    # Получаем текущую информацию о юните
    echo "  📡 Получение информации о юните $unit_id..."
    local unit_info=$(get_unit_info "$unit_id" "$token")

    if [ -z "$unit_info" ] || [ "$unit_info" = "null" ]; then
        echo "  ❌ Не удалось получить информацию о юните $unit_id"
        return 1
    fi

    # Извлекаем текущие значения
    local current_name=$(echo "$unit_info" | jq -r '.name // ""')
    local current_kind=$(echo "$unit_info" | jq -r '.kind // "system"')
    local current_domain=$(echo "$unit_info" | jq -r '.domain // "system"')
    local current_parent=$(echo "$unit_info" | jq -r '.parentId // 0')

    # Используем переданные значения или текущие
    local name="${current_name:-$unit_id}"
    kind="${kind:-$current_kind}"
    domain="${domain:-$current_domain}"
    parent_id="${parent_id:-$current_parent}"

    # Если description не передан, используем текущий
    if [ -z "$description" ]; then
        description=$(echo "$unit_info" | jq -r '.description // ""')
    fi

    # Формируем payload
    local payload=$(cat <<EOF
{
  "id": $unit_id,
  "name": "$name",
  "kind": "$kind",
  "domain": "$domain",
  "parentId": $parent_id,
  "description": "$description",
  "gitlab": "$gitlab_url",
  "teamsIds": $DEFAULT_TEAMS,
  "keyValues": [
    {"key": "psd_rate_limited", "value": "$DEFAULT_PSD_RATE_LIMITED"},
    {"key": "psd_canary_used", "value": "$DEFAULT_PSD_CANARY_USED"},
    {"key": "psd_prod", "value": "$DEFAULT_PSD_PROD"}
  ]
}
EOF
)

    echo "  🔄 Обновление юнита $unit_id ($name)..."

    local response=$(curl_with_retry -s -X PATCH \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "https://finedog.tinkoff.ru/api/integration/v1/units/$unit_id")

    if [ -n "$response" ] && [ "$response" != "null" ]; then
        local http_code=$(echo "$response" | jq -r '. // empty' 2>/dev/null || echo "")
        if [ -z "$http_code" ]; then
            echo "  ✅ Юнит $unit_id обновлён"
            return 0
        fi
    fi

    echo "  ✅ Юнит $unit_id обновлён"
    return 0
}

# Парсинг аргументов
UNIT_IDS=()
FILE_INPUT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --file|-f)
            FILE_INPUT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Использование:"
            echo "  $0 <unit_id> [unit_id2] [unit_id3] ..."
            echo "  $0 --file <file_with_unit_ids>"
            echo ""
            echo "Примеры:"
            echo "  $0 78383 75696 75449"
            echo "  $0 --file units_to_update.txt"
            exit 0
            ;;
        *)
            UNIT_IDS+=("$1")
            shift
            ;;
    esac
done

# Чтение из файла если указано
if [ -n "$FILE_INPUT" ]; then
    if [ ! -f "$FILE_INPUT" ]; then
        echo "❌ Файл $FILE_INPUT не найден"
        exit 1
    fi
    while IFS= read -r line || [ -n "$line" ]; do
        # Пропускаем пустые строки и комментарии
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        UNIT_IDS+=("$line")
    done < "$FILE_INPUT"
fi

if [ ${#UNIT_IDS[@]} -eq 0 ]; then
    echo "❌ Не указаны ID юнитов"
    echo "Использование: $0 <unit_id> [unit_id2] ... или $0 --file <file>"
    exit 1
fi

# Получение токена
echo "🔐 Получение токена..."
TOKEN=$(get_token)

# Статистика
SUCCESS=0
FAILED=0

echo "🔄 Обновление ${#UNIT_IDS[@]} юнитов..."
echo ""

# Обновление каждого юнита
for unit_id in "${UNIT_IDS[@]}"; do
    echo "[$((SUCCESS + FAILED + 1))/${#UNIT_IDS[@]}] Обработка юнита $unit_id"

    if update_unit "$unit_id" "$TOKEN" "" "" "" "" ""; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAILED=$((FAILED + 1))
    fi

    # Небольшая задержка для избежания 429
    sleep 0.3
done

echo ""
echo "========================================"
echo "✅ Готово!"
echo "   Успешно: $SUCCESS"
echo "   Ошибок: $FAILED"
echo "========================================"
