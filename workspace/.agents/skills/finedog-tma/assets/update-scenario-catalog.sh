#!/usr/bin/env bash
set -euo pipefail

# Обновление scenario-catalog.md — таблицы сценариев
# Запускает обновление данных из API и генерацию таблицы

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_FILE="/tmp/units_data.json"

echo "🔄 Обновление scenario-catalog.md..."

# 1. Обновление данных из API (если нет или старый)
if [[ ! -f "$DATA_FILE" ]] || [[ $(find "$DATA_FILE" -mmin +60) ]]; then
    echo "📡 Загрузка данных из Finedog API..."
    "$SCRIPT_DIR/update-units.sh"
else
    echo "✅ Данные из API актуальны (< 1 часа)"
fi

# 2. Загрузка кэша команд (если нет)
if [[ ! -f "$SCRIPT_DIR/teams_cache.json" ]]; then
    echo "👥 Загрузка кэша команд..."
    python3 "$SCRIPT_DIR/fetch-teams.py"
fi

# 3. Генерация таблицы
echo "📊 Генерация scenario-catalog.md..."
python3 "$SCRIPT_DIR/generate-scenario-catalog.py"

echo "✅ Scenario catalog обновлён!"
