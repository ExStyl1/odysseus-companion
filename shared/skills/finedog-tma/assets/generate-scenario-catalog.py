#!/usr/bin/env python3
"""
Генерация scenario-catalog.md — таблицы дочерних scenario юнитов от 5224.
Включены только юниты команды Loyalty TMA SRE.
"""

import json
import re
import os

# Путь к данным
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
DATA_FILE = '/tmp/units_data.json'
OUTPUT_FILE = os.path.join(REPO_ROOT, 'docs/metrics/scenario-catalog.md')
TEAMS_CACHE_FILE = os.path.join(REPO_ROOT, '.nessy/skills/finedog-tma/assets/teams_cache.json')

ROOT_UNIT_ID = 5224
ROOT_UNIT_NAME = "5224 (Коммуникационная платформа)"

# Исключения
EXCLUDE_PATTERNS = [
    r'.*\btest\b.*',       # Тестовые юниты
]


def build_parent_map(items):
    """Создаёт словарь для быстрого поиска родителя по ID."""
    return {u['id']: u for u in items}


def get_nearest_business_service(unit, parent_map):
    """
    Определяет ближайший business-service для данного юнита.
    Поднимаемся по цепочке родителей, пока не найдём юнит с kind == 'business-service'.
    """
    current_id = unit.get('id')
    visited = set()

    while current_id and current_id not in visited:
        visited.add(current_id)
        current = parent_map.get(current_id)

        if not current:
            break

        # Если нашли business-service
        if current.get('kind') == 'business-service':
            return f"{current_id} ({current.get('name', '')})"

        # Поднимаемся выше
        current_id = current.get('parentId')

    # Fallback — если не нашли
    return "N/A"


def parse_root_unit(root_str):
    """
    Парсит строку корневого юнита на ID и имя.
    Формат: "ID (Имя)"
    """
    match = re.match(r'^(\d+)\s*\((.+)\)$', root_str)
    if match:
        return match.group(1), match.group(2)
    return root_str, ''


def load_teams_cache():
    """Загрузка кэша команд."""
    if os.path.exists(TEAMS_CACHE_FILE):
        with open(TEAMS_CACHE_FILE, 'r') as f:
            data = json.load(f)
            return data.get('teams', {})
    return {}



def get_team_names(teams_ids, teams_cache):
    """
    Получение названий команд по ID.
    Возвращает кортеж (dev_team_name, sre_team_name).
    """
    dev_team = ''
    sre_team = ''

    for team_id in teams_ids:
        team = teams_cache.get(str(team_id), {})
        team_type = team.get('teamType', '')
        team_name = team.get('name', '')

        if team_type == 'dev' and not dev_team:
            dev_team = team_name
        elif team_type == 'sre' and not sre_team:
            sre_team = team_name

    return dev_team, sre_team


def has_marketing_sre_team(teams_ids, teams_cache):
    """Проверяет, есть ли у юнита команда Loyalty TMA SRE."""
    for team_id in teams_ids:
        team = teams_cache.get(str(team_id), {})
        if team.get('name', '') == 'Loyalty TMA SRE':
            return True
    return False


def should_exclude(unit):
    """Проверка юнита на исключение."""
    name = unit.get('name', '')
    visibility = unit.get('visibility', '')

    # Проверка visibility - тестовые юниты
    if visibility == 'test':
        return True

    # Проверка по regex паттернам
    for pattern in EXCLUDE_PATTERNS:
        if re.match(pattern, name):
            return True

    return False


def main():
    # Чтение данных
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    items = data.get('items', [])

    # Загрузка кэша команд
    teams_cache = load_teams_cache()
    if not teams_cache:
        print('⚠️  Кэш команд не найден. Запустите fetch-teams.py')
        return

    print(f'👥 Кэш команд загружен: {len(teams_cache)} команд')

    # Создаём карту родителей для быстрого поиска
    parent_map = build_parent_map(items)

    # Фильтрация: только scenario с командой Loyalty TMA SRE, исключаем родительский юнит 5224 и тестовые юниты
    filtered = [
        u for u in items
        if u.get('kind') == 'scenario'
        and u.get('id') != ROOT_UNIT_ID
        and not should_exclude(u)
        and has_marketing_sre_team(u.get('teamsIds', []), teams_cache)
    ]

    lines = []

    for unit in filtered:
        name = unit.get('name', '')
        uid = unit.get('id', '')
        kind = unit.get('kind', '')
        crit = unit.get('criticalityLevel', '') or ''
        consumer = unit.get('consumerType', '') or ''
        teams_ids = unit.get('teamsIds', [])

        # Получаем названия команд
        dev_team, sre_team = get_team_names(teams_ids, teams_cache)

        # Получаем ближайший business-service
        root = get_nearest_business_service(unit, parent_map)
        root_id, root_name = parse_root_unit(root)

        lines.append(f"| {name} | {uid} | {kind} | {crit} | {consumer} | {dev_team} | {sre_team} | {root_id} | {root_name} |")

    # Генерация контента
    content = f"""# Scenario Catalog — Коммуникационная платформа

> **Важно:** Таблица автоматически генерируется скриптом `generate-scenario-catalog.py`.
> Включены только юниты типа **scenario** команды **Loyalty TMA SRE**.
> Исключения: тестовые юниты (`visibility: test`, `test*` в имени).
> Корневой юнит: ближайший business-service в иерархии.

| Текущее имя юнита | ID юнита | Тип юнита | Критичность | Потребитель | Команда разработки | Команда SRE | ID корневого юнита | Имя корневого юнита |
|---|---|---|---|---|---|---|---|---|
{chr(10).join(lines)}

---

**Всего юнитов:** {len(filtered)}
"""

    # Запись файла
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"✓ Готово! Юнитов в таблице: {len(filtered)} (из {len(items)})")
    print(f"  Исключено: {len(items) - len(filtered)} юнитов")
    print(f"  Файл: {OUTPUT_FILE}")


if __name__ == '__main__':
    main()
