#!/usr/bin/env python3
"""
Генерация service-catalog.md — таблицы дочерних business-service юнитов от 5224.
Включены только юниты команды Loyalty TMA SRE.
"""

import json
import re
import os

# Путь к данным
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
DATA_FILE = '/tmp/units_data.json'
OUTPUT_FILE = os.path.join(REPO_ROOT, 'docs/metrics/service-catalog.md')
TEAMS_CACHE_FILE = os.path.join(REPO_ROOT, '.nessy/skills/finedog-tma/assets/teams_cache.json')

ROOT_UNIT_ID = 5224
ROOT_UNIT_NAME = "5224 (Коммуникационная платформа)"

# Исключения
EXCLUDE_PATTERNS = [
    r'.*\btest\b.*',       # Тестовые юниты
]

EXCLUDE_KINDS = []

EXCLUDE_UNIT_IDS = []


def build_parent_map(items):
    """Создаёт словарь для быстрого поиска родителя по ID."""
    return {u['id']: u for u in items}


def get_root_unit(unit, parent_map):
    """
    Определяет корневой юнит для данного юнита.

    Корневой юнит — это прямой наследник 5224, который является предком данного юнита.
    Поднимаемся по цепочке родителей, пока не найдём юнит с parentId == 5224.
    """
    current_id = unit.get('parentId')
    visited = set()

    while current_id and current_id not in visited:
        visited.add(current_id)
        current = parent_map.get(current_id)

        if not current:
            break

        # Если нашли прямого наследника 5224
        if current.get('parentId') == ROOT_UNIT_ID:
            return f"{current_id} ({current.get('name', '')})"

        # Поднимаемся выше
        current_id = current.get('parentId')

    # Fallback — если не нашли, возвращаем 5224
    return ROOT_UNIT_NAME


def parse_root_unit(root_str):
    """
    Парсит строку корневого юнита на ID и имя.
    Формат: "ID (Имя)" или "5224 (Коммуникационная платформа)"
    """
    match = re.match(r'^(\d+)\s*\((.+)\)$', root_str)
    if match:
        return match.group(1), match.group(2)
    return root_str, ''


def is_descendant_of_excluded_unit(unit, parent_map):
    """Проверяет, является ли юнит потомком исключённого юнита."""
    return False


def should_exclude(unit, parent_map):
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

    # Фильтрация: только business-service с командой Loyalty TMA SRE, исключаем родительский юнит 5224 и тестовые юниты
    filtered = [
        u for u in items
        if u.get('kind') == 'business-service'
        and u.get('id') != ROOT_UNIT_ID
        and not should_exclude(u, None)
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

        # Получаем корневой юнит
        root = get_root_unit(unit, parent_map)
        root_id, root_name = parse_root_unit(root)

        lines.append(f"| {name} | {uid} | {kind} | {crit} | {consumer} | {dev_team} | {sre_team} | {root_id} | {root_name} |")

    # Генерация контента
    content = f"""# Service Catalog — Коммуникационная платформа

> **Важно:** Таблица автоматически генерируется скриптом `generate-service-catalog.py`.
> Включены только юниты типа **business-service** команды **Loyalty TMA SRE**.
> Исключения: тестовые юниты (`visibility: test`, `test*` в имени).

| Текущее имя юнита | ID юнита | Тип юнита | Критичность | Потребитель | Команда разработки | Команда SRE | ID корневого юнита | Имя корневого юнита |
|---|---|---|---|---|---|---|---|---|
{chr(10).join(lines)}

---

**Всего юнитов:** {len(filtered)}
"""

    # Запись файла
    output_path = os.path.abspath(OUTPUT_FILE)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"✓ Готово! Юнитов в таблице: {len(filtered)} (из {len(items)})")
    print(f"  Исключено: {len(items) - len(filtered)} юнитов")
    print(f"  Файл: {output_path}")


if __name__ == '__main__':
    main()
