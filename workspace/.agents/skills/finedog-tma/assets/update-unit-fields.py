#!/usr/bin/env python3
"""
Скрипт обновления полей юнитов в Finedog API.
Обновляет: chatSupport, chatTalk, chatNews, jira, wiki, gitlab, teamsIds, keyValues, description

Использование:
    python update-unit-fields.py <unit_id> [unit_id2] [unit_id3] ...
    python update-unit-fields.py --file units_to_update.txt
    python update-unit-fields.py --config update_config.json

Примеры:
    python update-unit-fields.py 78383 75696 75449
    python update-unit-fields.py --file units.txt
    python update-unit-fields.py --config config.json
"""

import json
import os
import sys
import urllib.request
import urllib.error
import time
import argparse

# Настройки
REPO_ROOT = os.environ.get('PWD') or os.getcwd()

ENV_FILE = os.path.join(REPO_ROOT, '.env')
API_BASE = 'https://finedog.tinkoff.ru/api/integration'

# Параметры по умолчанию для всех команд
DEFAULTS = {
    'chatSupport': '~tma-sre',
    'teamsIds': [36],  # Loyalty TMA SRE
    'psd_rate_limited': 'na',
    'psd_canary_used': 'na',
    'psd_prod': 'true'
}

# Параметры retry для обработки HTTP 429
MAX_RETRIES = 5
RETRY_DELAY = 1


def make_request_with_retry(url, data=None, headers=None, method='GET', timeout=30, return_json=True):
    """
    Выполняет HTTP-запрос с retry при HTTP 429.
    Использует экспоненциальную задержку между попытками.
    
    return_json: если False, возвращает (None, status_code) вместо парсинга JSON
    """
    retry_count = 0
    delay = RETRY_DELAY

    while retry_count < MAX_RETRIES:
        try:
            req = urllib.request.Request(
                url,
                data=data,
                headers=headers or {},
                method=method
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                response_body = response.read().decode('utf-8')
                if return_json and response_body.strip():
                    return json.loads(response_body), response.status
                else:
                    return None, response.status

        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_count += 1
                if retry_count < MAX_RETRIES:
                    print(f'      ⚠️  HTTP 429. Попытка {retry_count}/{MAX_RETRIES}. Ожидание {delay}с...')
                    time.sleep(delay)
                    delay *= 2
                    continue
                else:
                    print(f'      ❌ Превышено количество попыток ({MAX_RETRIES}) из-за HTTP 429')
                    return None, e.code
            else:
                print(f'      Ошибка {e.code}: {e.reason}')
                return None, e.code

        except json.JSONDecodeError as e:
            # Пустой ответ или не JSON
            print(f'      ⚠️  Пустой ответ (ожидаемо для PATCH): {e}')
            return None, 200

        except Exception as e:
            print(f'      Ошибка: {e}')
            retry_count += 1
            if retry_count < MAX_RETRIES:
                time.sleep(delay)
                delay *= 2
                continue
            return None, 0

    return None, 0


def get_token():
    """Извлечение JWT токена из .env файла."""
    if not os.path.exists(ENV_FILE):
        print(f'❌ Файл {ENV_FILE} не найден')
        return None

    with open(ENV_FILE, 'r') as f:
        for line in f:
            if line.startswith('token=Bearer '):
                return line.strip().replace('token=Bearer ', '')

    print('❌ Токен не найден в .env. Запустите ./finedog-auth.sh')
    return None


def get_unit_info(unit_id, token):
    """Получение информации о юните."""
    url = f'{API_BASE}/v1/units/{unit_id}'
    headers = {'Authorization': f'Bearer {token}'}

    result, status = make_request_with_retry(url, headers=headers)
    return result


def update_unit(unit_id, token, custom_fields=None):
    """
    Обновление юнита с применением стандартных и кастомных полей.

    custom_fields: dict с опциональными полями:
        - description: описание юнита
        - gitlab_name: имя репозитория для формирования gitlab URL
        - kind: тип юнита (system, component, business-service, etc.)
        - domain: домен (system, service)
        - parentId: ID родителя
    """
    custom_fields = custom_fields or {}

    # Получаем текущую информацию о юните
    print(f'  📡 Получение информации о юните {unit_id}...')
    unit_info = get_unit_info(unit_id, token)

    if not unit_info:
        print(f'  ❌ Не удалось получить информацию о юните {unit_id}')
        return False

    # Формируем payload с текущими значениями и обновлениями
    payload = {
        'id': unit_id,
        'name': unit_info.get('name', str(unit_id)),
        'kind': custom_fields.get('kind', unit_info.get('kind', 'system')),
        'domain': custom_fields.get('domain', unit_info.get('domain', 'system')),
        'parentId': custom_fields.get('parentId', unit_info.get('parentId', 0)),
        'description': custom_fields.get('description', unit_info.get('description', '')),
        'chatSupport': custom_fields.get('chatSupport', unit_info.get('chatSupport', DEFAULTS['chatSupport'])),
        'chatTalk': custom_fields.get('chatTalk', unit_info.get('chatTalk', '')),
        'chatNews': custom_fields.get('chatNews', unit_info.get('chatNews', '')),
        'jira': custom_fields.get('jira', unit_info.get('jira', '')),
        'wiki': custom_fields.get('wiki', unit_info.get('wiki', '')),
        'gitlab': custom_fields.get('gitlab', unit_info.get('gitlab', '')),
        'teamsIds': custom_fields.get('teamsIds', unit_info.get('teamsIds', DEFAULTS['teamsIds'])),
        'keyValues': [
            {'key': 'psd_rate_limited', 'value': custom_fields.get('psd_rate_limited', unit_info.get('psd_rate_limited', DEFAULTS['psd_rate_limited']))},
            {'key': 'psd_canary_used', 'value': custom_fields.get('psd_canary_used', unit_info.get('psd_canary_used', DEFAULTS['psd_canary_used']))},
            {'key': 'psd_prod', 'value': custom_fields.get('psd_prod', unit_info.get('psd_prod', DEFAULTS['psd_prod']))}
        ]
    }

    # Формируем GitLab URL
    gitlab_name = custom_fields.get('gitlab_name')
    if gitlab_name:
        payload['gitlab'] = f"{DEFAULTS['gitlabBase']}/{gitlab_name}"
    elif unit_info.get('gitlab'):
        payload['gitlab'] = unit_info.get('gitlab')

    # Отправляем запрос на обновление
    url = f'{API_BASE}/v1/units/{unit_id}'
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }

    data = json.dumps(payload).encode('utf-8')

    print(f'  🔄 Обновление юнита {unit_id} ({payload["name"]})...')

    result, status = make_request_with_retry(
        url,
        data=data,
        headers=headers,
        method='PATCH'
    )

    if status >= 200 and status < 300:
        print(f'  ✅ Юнит {unit_id} обновлён')
        return True
    else:
        print(f'  ❌ Ошибка обновления юнита {unit_id} (HTTP {status})')
        return False


def load_unit_ids_from_file(file_path):
    """Загрузка списка ID юнитов из файла."""
    unit_ids = []
    with open(file_path, 'r') as f:
        for line in f:
            line = line.strip()
            # Пропускаем пустые строки и комментарии
            if line and not line.startswith('#'):
                unit_ids.append(line)
    return unit_ids


def load_config(config_path):
    """Загрузка конфигурации из JSON файла."""
    with open(config_path, 'r') as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(
        description='Обновление полей юнитов в Finedog API'
    )
    parser.add_argument(
        'unit_ids',
        nargs='*',
        help='ID юнитов для обновления'
    )
    parser.add_argument(
        '--file', '-f',
        help='Файл со списком ID юнитов (по одному в строке)'
    )
    parser.add_argument(
        '--config', '-c',
        help='JSON файл с конфигурацией (кастомные поля для юнитов)'
    )
    parser.add_argument(
        '--defaults',
        action='store_true',
        help='Показать значения по умолчанию и выйти'
    )

    args = parser.parse_args()

    # Показать значения по умолчанию
    if args.defaults:
        print('Значения по умолчанию:')
        for key, value in DEFAULTS.items():
            print(f'  {key}: {value}')
        return 0

    # Сбор всех ID юнитов
    unit_ids = list(args.unit_ids) if args.unit_ids else []

    if args.file:
        if not os.path.exists(args.file):
            print(f'❌ Файл {args.file} не найден')
            return 1
        unit_ids.extend(load_unit_ids_from_file(args.file))

    if args.config:
        if not os.path.exists(args.config):
            print(f'❌ Файл {args.config} не найден')
            return 1
        config = load_config(args.config)
        # Если в конфиге есть unit_ids, добавляем их
        if 'unit_ids' in config:
            unit_ids.extend(config['unit_ids'])

    if not unit_ids:
        print('❌ Не указаны ID юнитов')
        print('Использование:')
        print('  python update-unit-fields.py <unit_id> [unit_id2] ...')
        print('  python update-unit-fields.py --file units.txt')
        print('  python update-unit-fields.py --config config.json')
        return 1

    # Получение токена
    print('🔐 Получение токена...')
    token = get_token()
    if not token:
        return 1

    # Загрузка конфигурации если есть
    config = {}
    if args.config:
        config = load_config(args.config)
        custom_configs = config.get('units', {})
    else:
        custom_configs = {}

    # Статистика
    success = 0
    failed = 0

    print(f'🔄 Обновление {len(unit_ids)} юнитов...')
    print()

    # Обновление каждого юнита
    for i, unit_id in enumerate(unit_ids, 1):
        print(f'[{i}/{len(unit_ids)}] Обработка юнита {unit_id}')

        # Получаем кастомную конфигурацию для этого юнита если есть
        custom_fields = custom_configs.get(str(unit_id), {})

        if update_unit(unit_id, token, custom_fields):
            success += 1
        else:
            failed += 1

        # Небольшая задержка для избежания 429
        time.sleep(0.3)

    print()
    print('=' * 50)
    print('✅ Готово!')
    print(f'   Успешно: {success}')
    print(f'   Ошибок: {failed}')
    print('=' * 50)

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
