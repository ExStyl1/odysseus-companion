#!/usr/bin/env bash
# Проверка синхронизации документации EN→RU
# Использование: ./sync-check.sh docs/file.md docs-ru/.../file.md

set -euo pipefail

EN_FILE="${1:-}"
RU_FILE="${2:-}"

if [[ -z "$EN_FILE" || -z "$RU_FILE" ]]; then
    echo "❌ Укажите файлы: ./sync-check.sh docs/file.md docs-ru/.../file.md"
    exit 1
fi

if [[ ! -f "$EN_FILE" ]]; then
    echo "❌ Файл не найден: $EN_FILE"
    exit 1
fi

if [[ ! -f "$RU_FILE" ]]; then
    echo "❌ Файл не найден: $RU_FILE"
    exit 1
fi

echo "🔍 Проверка синхронизации:"
echo "   EN: $EN_FILE"
echo "   RU: $RU_FILE"
echo ""

# 1. Проверка количества разделов
echo "📊 Разделы (##):"
EN_SECTIONS=$(grep -c "^## " "$EN_FILE")
RU_SECTIONS=$(grep -c "^## " "$RU_FILE")
echo "   EN: $EN_SECTIONS"
echo "   RU: $RU_SECTIONS"

if [[ "$EN_SECTIONS" -eq "$RU_SECTIONS" ]]; then
    echo "   ✅ Совпадает"
else
    echo "   ❌ Расхождение: $((EN_SECTIONS - RU_SECTIONS)) разделов"
fi
echo ""

# 2. Проверка количества подразделов
echo "📊 Подразделы (###):"
EN_SUBSECTIONS=$(grep -c "^### " "$EN_FILE")
RU_SUBSECTIONS=$(grep -c "^### " "$RU_FILE")
echo "   EN: $EN_SUBSECTIONS"
echo "   RU: $RU_SUBSECTIONS"

if [[ "$EN_SUBSECTIONS" -eq "$RU_SUBSECTIONS" ]]; then
    echo "   ✅ Совпадает"
else
    echo "   ⚠️  Расхождение: $((EN_SUBSECTIONS - RU_SUBSECTIONS)) подразделов"
fi
echo ""

# 3. Проверка количества строк
echo "📊 Количество строк:"
EN_LINES=$(wc -l < "$EN_FILE")
RU_LINES=$(wc -l < "$RU_FILE")
DIFF=$((EN_LINES - RU_LINES))
DIFF_PERCENT=$((DIFF * 100 / EN_LINES))

echo "   EN: $EN_LINES"
echo "   RU: $RU_LINES"
echo "   Разница: $DIFF строк ($DIFF_PERCENT%)"

if [[ $DIFF_PERCENT -lt 10 ]]; then
    echo "   ✅ В норме"
elif [[ $DIFF_PERCENT -lt 20 ]]; then
    echo "   ⚠️  Требует проверки"
else
    echo "   ❌ Критично — вероятны пропуски"
fi
echo ""

# 4. Проверка bullet points
echo "📊 Элементы списка (- **):"
EN_BULLETS=$(grep -c "^- \*\*" "$EN_FILE" || echo 0)
RU_BULLETS=$(grep -c "^- \*\*" "$RU_FILE" || echo 0)
echo "   EN: $EN_BULLETS"
echo "   RU: $RU_BULLETS"

if [[ "$EN_BULLETS" -eq "$RU_BULLETS" ]]; then
    echo "   ✅ Совпадает"
else
    echo "   ⚠️  Расхождение: $((EN_BULLETS - RU_BULLETS)) пунктов"
fi
echo ""

# 5. Проверка типичных проблем
echo "🔍 Проверка типичных проблем:"

# Двойные backticks
DOUBLE_BACKTICKS=$(grep -c "``" "$RU_FILE" || echo 0)
if [[ "$DOUBLE_BACKTICKS" -gt 0 ]]; then
    echo "   ⚠️  Двойные backticks: $DOUBLE_BACKTICKS вхождений"
else
    echo "   ✅ Backticks в порядке"
fi

# Неправильная терминология
BAD_TERMS=0
if grep -q "безголов[ыио]м режим[еом]" "$RU_FILE"; then
    echo "   ⚠️  Найдено: 'безголовый режим' (должно быть 'режим без интерфейса')"
    BAD_TERMS=$((BAD_TERMS + 1))
fi

if grep -q "токен носителя" "$RU_FILE"; then
    echo "   ⚠️  Найдено: 'токен носителя' (должно быть 'bearer-токен')"
    BAD_TERMS=$((BAD_TERMS + 1))
fi

if [[ "$BAD_TERMS" -eq 0 ]]; then
    echo "   ✅ Терминология в порядке"
fi
echo ""

# 6. Детальная проверка по разделам
echo "📊 Детальная проверка по разделам:"
echo "   | Раздел | EN строк | RU строк | Разница |"
echo "   |--------|----------|----------|---------|"

# Извлечь заголовки разделов
mapfile -t EN_HEADERS < <(grep "^## " "$EN_FILE" | sed 's/^## //')

for header in "${EN_HEADERS[@]}"; do
    # Перевести заголовок (упрощённо — поиск по ключевым словам)
    case "$header" in
        "What it gives you") RU_HEADER="Что это даёт" ;;
        "Quickstart") RU_HEADER="Быстрый старт" ;;
        "Authentication") RU_HEADER="Аутентификация" ;;
        "CLI flags") RU_HEADER="Флаги CLI" ;;
        "Default deployment threat model") RU_HEADER="Модель угроз развёртывания по умолчанию" ;;
        "Multi-session & multi-workspace deployment") RU_HEADER="Развёртывание с несколькими сессиями и рабочими пространствами" ;;
        "Loading and resuming a persisted session") RU_HEADER="Загрузка и возобновление сохранённой сессии" ;;
        "Durability model") RU_HEADER="Модель долговечности" ;;
        "Stage 1.5+ runtime guarantees") RU_HEADER="Гарантии выполнения Stage 1.5+" ;;
        "Stage 1 scope boundaries"*) RU_HEADER="Границы области Stage 1" ;;
        "Logging in to a remote daemon"*) RU_HEADER="Вход в удалённый демон" ;;
        "What's next") RU_HEADER="Что дальше" ;;
        *) RU_HEADER="$header" ;;
    esac
    
    # Посчитать строки в разделе EN
    EN_SECTION_LINES=$(sed -n "/^## $header\$/,/^## /p" "$EN_FILE" | wc -l)
    
    # Посчитать строки в разделе RU
    RU_SECTION_LINES=$(sed -n "/^## $RU_HEADER\$/,/^## /p" "$RU_FILE" | wc -l)
    
    SECTION_DIFF=$((EN_SECTION_LINES - RU_SECTION_LINES))
    if [[ $SECTION_DIFF -lt 0 ]]; then
        SECTION_DIFF="-$SECTION_DIFF"
    fi
    
    STATUS="✅"
    if [[ $SECTION_DIFF -gt 10 ]]; then
        STATUS="⚠️"
    fi
    if [[ $SECTION_DIFF -gt 20 ]]; then
        STATUS="❌"
    fi
    
    printf "   | %-20s | %8d | %8d | %7d | %s\n" "${header:0:20}" "$EN_SECTION_LINES" "$RU_SECTION_LINES" "$SECTION_DIFF" "$STATUS"
done

echo ""
echo "🏁 Проверка завершена"
