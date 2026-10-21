#!/usr/bin/env python3
"""
Подсчёт инцидентов для юнитов Communication Platform.
Рабочее время: пн-пт, 10:00-19:00 MSK (UTC+3)
Внерабочее время: остальное время
"""

import json
import urllib.request
import urllib.error
import os
import time
from datetime import datetime, timedelta
from collections import defaultdict

# Настройки
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
ENV_FILE = os.path.join(REPO_ROOT, '.env')
DATA_FILE = '/tmp/units_data.json'
OUTPUT_FILE = os.path.join(REPO_ROOT, '.nessy/skills/finedog-tma/assets/incidents_cache.json')
API_BASE = 'https://finedog.tinkoff.ru/api/integration'
INCIDENTS_FROM = '2026-01-01T00:00:00Z'

# Параметры retry для обработки HTTP 429
MAX_RETRIES = 5
RETRY_DELAY = 1  # начальная задержка в секундах


def make_request_with_retry(url, data=None, headers=None, timeout=30):
    """
    Выполняет HTTP-запрос с retry при HTTP 429.
    Использует экспоненциальную задержку между попытками.
    """
    retry_count = 0
    delay = RETRY_DELAY
    
    while retry_count < MAX_RETRIES:
        try:
            req = urllib.request.Request(url, data=data, headers=headers or {}, method='POST' if data else 'GET')
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_count += 1
                if retry_count < MAX_RETRIES:
                    print(f'      ⚠️  HTTP 429 (Too Many Requests). Попытка {retry_count}/{MAX_RETRIES}. Ожидание {delay}с...')
                    time.sleep(delay)
                    delay *= 2  # экспоненциальная задержка
                    continue
                else:
                    print(f'      ❌ Превышено максимальное количество попыток ({MAX_RETRIES}) из-за HTTP 429')
                    raise
            else:
                print(f'      Ошибка {e.code}: {e.reason}')
                raise
        except Exception as e:
            print(f'      Ошибка: {e}')
            raise
    
    return None


# MSK timezone offset (UTC+3)
MSK_OFFSET_HOURS = 3


def get_token():
    """Получение токена из .env файла."""
    with open(ENV_FILE, 'r') as f:
        for line in f:
            if line.startswith('token=Bearer '):
                return line.strip().replace('token=Bearer ', '')
    return None


def is_business_hours(impact_started_at_str):
    """
    Проверка, произошло ли событие в рабочее время.
    Рабочее время: пн-пт, 10:00-19:00 MSK (UTC+3)
    """
    # Парсим дату
    dt = datetime.fromisoformat(impact_started_at_str.replace('Z', '+00:00'))

    # Конвертируем в MSK (UTC+3)
    msk_dt = dt + timedelta(hours=MSK_OFFSET_HOURS)

    # Проверяем день недели (0=пн, 6=вс)
    weekday = msk_dt.weekday()
    hour = msk_dt.hour

    # Рабочее время: пн-пт (0-4), 10:00-18:59
    if weekday < 5 and 10 <= hour < 19:
        return True
    return False


def fetch_incidents_for_unit(token, unit_id, include_child_units=False):
    """Получение всех инцидентов для юнита с пагинацией."""
    incidents = []
    page = 1
    page_size = 100

    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }

    while True:
        payload = {
            'page': page,
            'pageSize': page_size,
            'unitIds': [unit_id],
            'includeChildUnits': include_child_units,
            'impactStartedAtFrom': INCIDENTS_FROM
        }

        try:
            data = make_request_with_retry(
                f'{API_BASE}/v1/incidents/list',
                data=json.dumps(payload).encode('utf-8'),
                headers=headers,
                timeout=30
            )
            if not data:
                break
        except Exception as e:
            print(f'  Ошибка {e} для юнита {unit_id}')
            break

        items = data.get('items', [])
        incidents.extend(items)

        if not data.get('hasNextPage', False):
            break

        page += 1

    return incidents


def get_all_units():
    """Получение списка всех юнитов (не только корневых)."""
    with open(DATA_FILE, 'r') as f:
        data = json.load(f)

    items = data.get('items', [])
    # Возвращаем все юниты кроме 5224
    return [u for u in items if u.get('id') != 5224]


def main():
    token = get_token()
    if not token:
        print('❌ Токен не найден')
        return

    print('🔍 Получение списка всех юнитов...')
    all_units = get_all_units()
    print(f'  Найдено юнитов: {len(all_units)}')

    incidents_by_unit = {}

    for i, unit in enumerate(all_units, 1):
        unit_id = unit.get('id')
        unit_name = unit.get('name', '')[:40]
        print(f'[{i}/{len(all_units)}] Загрузка инцидентов для юнита {unit_id} ({unit_name}...)')

        # Задержка для избежания 429
        if i > 1:
            time.sleep(0.3)

        incidents = fetch_incidents_for_unit(token, unit_id, include_child_units=False)

        # Подсчёт по времени
        business_count = 0
        non_business_count = 0

        for inc in incidents:
            impact_started = inc.get('impactStartedAt')
            if impact_started:
                if is_business_hours(impact_started):
                    business_count += 1
                else:
                    non_business_count += 1

        incidents_by_unit[str(unit_id)] = {
            'total': len(incidents),
            'business_hours': business_count,
            'non_business_hours': non_business_count
        }
        print(f'    Всего: {len(incidents)}, Рабочее: {business_count}, Внерабочее: {non_business_count}')

    # Сохранение кэша
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(incidents_by_unit, f, indent=2)

    print(f'✅ Кэш сохранён в {OUTPUT_FILE}')


if __name__ == '__main__':
    main()
