#!/usr/bin/env python3
"""
Скрипт архивации/разархивации юнитов в Finedog API.
Использует POST /api/integration/v1/units/{id}/archive endpoint.

Использование:
    python archive-units.py <unit_id> [unit_id2] ...
    python archive-units.py --file units_to_archive.txt
    python archive-units.py --unarchive <unit_id> [unit_id2] ...

Примеры:
    python archive-units.py 48346 28325
    python archive-units.py --file archived_units.txt
    python archive-units.py --unarchive 28325
"""

import json
import os
import sys
import urllib.request
import urllib.error
import argparse

# Настройки
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
ENV_FILE = os.path.join(REPO_ROOT, '.env')
API_BASE = 'https://finedog.tinkoff.ru/api/integration'


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

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f'  ❌ Ошибка получения: {e}')
        return None


def archive_unit(unit_id, token):
    """
    Архивация юнита в Finedog через POST /v1/units/{id}/archive.
    """
    # Получаем текущую информацию о юните
    print(f'  📡 Чтение юнита {unit_id}...')
    unit_info = get_unit_info(unit_id, token)

    if not unit_info:
        print(f'  ❌ Не удалось получить информацию о юните {unit_id}')
        return False

    # Проверяем, не заархивирован ли уже
    if unit_info.get('isArchived') is True:
        print(f'  ℹ️  Юнит {unit_id} ({unit_info.get("name")}) уже заархивирован')
        return True

    # Отправляем запрос на архивацию через специальный endpoint
    url = f'{API_BASE}/v1/units/{unit_id}/archive'
    headers = {'Authorization': f'Bearer {token}'}

    print(f'  🔄 Архивация юнита {unit_id} ({unit_info.get("name")})...')

    try:
        req = urllib.request.Request(url, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=30) as response:
            # Endpoint возвращает HTTP 200 или 204 No Content при успехе
            if response.status in [200, 204]:
                print(f'  ✅ Юнит {unit_id} заархивирован')
                return True
            else:
                print(f'  ⚠️  Неожиданный статус ответа: {response.status}')
                return False
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f'  ❌ Ошибка {e.code}: {error_body}')
        return False
    except Exception as e:
        print(f'  ❌ Ошибка: {e}')
        return False


def unarchive_unit(unit_id, token):
    """
    Разархивация юнита в Finedog через DELETE /v1/units/{id}/archive.
    """
    # Получаем текущую информацию о юните
    print(f'  📡 Чтение юнита {unit_id}...')
    unit_info = get_unit_info(unit_id, token)

    if not unit_info:
        print(f'  ❌ Не удалось получить информацию о юните {unit_id}')
        return False

    # Проверяем, не активен ли уже
    if unit_info.get('isArchived') is False:
        print(f'  ℹ️  Юнит {unit_id} ({unit_info.get("name")}) уже активен')
        return True

    # Отправляем запрос на разархивацию
    url = f'{API_BASE}/v1/units/{unit_id}/archive'
    headers = {'Authorization': f'Bearer {token}'}

    print(f'  🔄 Разархивация юнита {unit_id} ({unit_info.get("name")})...')

    try:
        req = urllib.request.Request(url, headers=headers, method='DELETE')
        with urllib.request.urlopen(req, timeout=30) as response:
            # Endpoint возвращает HTTP 200 или 204 No Content при успехе
            if response.status in [200, 204]:
                print(f'  ✅ Юнит {unit_id} разархивирован')
                return True
            else:
                print(f'  ⚠️  Неожиданный статус ответа: {response.status}')
                return False
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f'  ❌ Ошибка {e.code}: {error_body}')
        return False
    except Exception as e:
        print(f'  ❌ Ошибка: {e}')
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Архивация/разархивация юнитов в Finedog',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Примеры:
  # Архивировать юниты
  python archive-units.py 48346 28325
  
  # Разархивировать юниты
  python archive-units.py --unarchive 48346 28325
  
  # Из файла со списком ID
  python archive-units.py --file units_to_archive.txt
        """
    )
    parser.add_argument('unit_ids', nargs='*', type=int, help='ID юнитов для операции')
    parser.add_argument('--file', type=str, help='Файл со списком ID юнитов (по одному в строке)')
    parser.add_argument('--unarchive', action='store_true', help='Разархивировать вместо архивации')
    args = parser.parse_args()

    # Получаем список юнитов
    unit_ids = list(args.unit_ids) if args.unit_ids else []

    if args.file:
        with open(args.file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and line.isdigit():
                    unit_ids.append(int(line))

    if not unit_ids:
        print('❌ Не указаны юниты для операции')
        print('Используйте: python archive-units.py <unit_id> [unit_id2] ...')
        print('           или: python archive-units.py --file units.txt')
        sys.exit(1)

    # Получаем токен
    token = get_token()
    if not token:
        sys.exit(1)

    operation = "Разархивация" if args.unarchive else "Архивация"
    print(f'🔐 Токен получен')
    print(f'📋 {operation} юнитов: {len(unit_ids)}')
    print()

    # Выполняем операцию
    success_count = 0
    failed_count = 0

    for unit_id in unit_ids:
        if args.unarchive:
            if unarchive_unit(unit_id, token):
                success_count += 1
            else:
                failed_count += 1
        else:
            if archive_unit(unit_id, token):
                success_count += 1
            else:
                failed_count += 1
        print()

    # Итоги
    print('=' * 60)
    print('ИТОГИ:')
    print(f'  {operation}: {success_count}')
    print(f'  Ошибок: {failed_count}')
    print('=' * 60)

    sys.exit(0 if failed_count == 0 else 1)


if __name__ == '__main__':
    main()
