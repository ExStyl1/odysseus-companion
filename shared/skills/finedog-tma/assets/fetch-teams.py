#!/usr/bin/env python3
"""
Загрузка кэша команд из Finedog API.
Сохраняет информацию о всех командах (dev и sre) в teams_cache.json.
"""

import json
import urllib.request
import urllib.error
import os
import time

# Настройки
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
ENV_FILE = os.path.join(REPO_ROOT, '.env')
OUTPUT_FILE = os.path.join(REPO_ROOT, '.nessy/skills/finedog-tma/assets/teams_cache.json')
API_BASE = 'https://finedog.tinkoff.ru/api/integration'

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
                    print(f'    ⚠️  HTTP 429 (Too Many Requests). Попытка {retry_count}/{MAX_RETRIES}. Ожидание {delay}с...')
                    time.sleep(delay)
                    delay *= 2  # экспоненциальная задержка
                    continue
                else:
                    print(f'    ❌ Превышено максимальное количество попыток ({MAX_RETRIES}) из-за HTTP 429')
                    raise
            else:
                print(f'    Ошибка {e.code}: {e.reason}')
                raise
        except Exception as e:
            print(f'    Ошибка: {e}')
            raise
    
    return None


def get_token():
    """Извлечение JWT токена из .env файла."""
    if not os.path.exists(ENV_FILE):
        print(f'❌ Файл {ENV_FILE} не найден')
        return None

    with open(ENV_FILE, 'r') as f:
        for line in f:
            if line.startswith('token=Bearer '):
                return line.strip().replace('token=Bearer ', '')

    print('❌ Токен не найден в .env')
    return None


def fetch_all_teams(token):
    """Загрузка всех команд из API."""
    teams = []
    page = 1
    page_size = 100

    while True:
        url = f'{API_BASE}/v1/teams/list'
        data = json.dumps({
            'page': page,
            'pageSize': page_size
        }).encode('utf-8')

        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }

        try:
            result = make_request_with_retry(url, data=data, headers=headers, timeout=30)
            if not result:
                break
                
            items = result.get('items', [])

            if not items:
                break

            teams.extend(items)
            print(f'  Страница {page}: загружено {len(items)} команд (всего: {len(teams)})')

            if len(items) < page_size:
                break

            page += 1
            time.sleep(0.2)  # Дополнительная задержка для избежания 429

        except Exception as e:
            print(f'  Ошибка при загрузке страницы {page}: {e}')
            break

    return teams


def main():
    token = get_token()
    if not token:
        return

    print('🔍 Загрузка команд из Finedog API...')
    all_teams = fetch_all_teams(token)
    print(f'✅ Загружено {len(all_teams)} команд')

    # Создаём словарь по ID команды
    teams_dict = {str(team.get('id')): team for team in all_teams}

    # Сохранение кэша
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(teams_dict, f, indent=2, ensure_ascii=False)

    print(f'💾 Кэш сохранён в {OUTPUT_FILE}')

    # Статистика по типам команд
    dev_count = sum(1 for t in all_teams if t.get('teamType') == 'dev')
    sre_count = sum(1 for t in all_teams if t.get('teamType') == 'sre')
    other_count = len(all_teams) - dev_count - sre_count

    print(f'📊 Типы команд: dev={dev_count}, sre={sre_count}, other={other_count}')


if __name__ == '__main__':
    main()
