#!/usr/bin/env bash
# Автоматическое исправление типичных проблем синхронизации документации
# Использование: ./auto-fix.sh docs-ru/users/work/features/file.md

set -euo pipefail

RU_FILE="${1:-}"

if [[ -z "$RU_FILE" ]]; then
    echo "❌ Укажите файл: ./auto-fix.sh docs-ru/.../file.md"
    exit 1
fi

if [[ ! -f "$RU_FILE" ]]; then
    echo "❌ Файл не найден: $RU_FILE"
    exit 1
fi

echo "🔍 Автоматическое исправление: $RU_FILE"

# 1. Исправление двойных backticks на одинарные (для CLI флагов)
echo "📝 Исправление экранирования CLI флагов..."
sed -i.bak 's/``\(--[a-zA-Z0-9_-]*\)``/`\1`/g' "$RU_FILE"
sed -i.bak 's/``\([a-zA-Z0-9_.:/-]*\)`\{2\}/`\1`/g' "$RU_FILE"

# 2. Исправление терминологии
echo "📝 Исправление терминологии..."

# "безголовый режим" → "режим без интерфейса"
sed -i.bak 's/безголов[ыио]м режим[еом]/режиме без интерфейса/g' "$RU_FILE"
sed -i.bak 's/безголовый режим/режим без интерфейса/g' "$RU_FILE"

# "токен носителя" → "bearer-токен"
sed -i.bak 's/токен носителя/bearer-токен/g' "$RU_FILE"
sed -i.bak 's/токена носителя/bearer-токена/g' "$RU_FILE"

# "аутентификация носителя" → "bearer-аутентификация"
sed -i.bak 's/аутентификаци[ия] носителя/bearer-аутентификаци[ия]/g' "$RU_FILE"

# 3. Исправление кавычек в markdown
echo "📝 Исправление кавычек..."
sed -i.bak 's/"\([a-zA-Z0-9_-]*:[[:space:]]*'\''[^'\'']*\'''\''"\)/`\1`/g' "$RU_FILE"

# 4. Удаление backup файлов
rm -f "${RU_FILE}.bak"

echo "✅ Исправление завершено"
echo ""
echo "📊 Проверка изменений:"
git diff --stat "$RU_FILE" 2>/dev/null || echo "(git не доступен)"
