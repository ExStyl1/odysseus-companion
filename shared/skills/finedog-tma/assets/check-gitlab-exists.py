#!/usr/bin/env python3
"""
Проверка существования GitLab репозиториев для юнитов Finedog.
Находит юниты, у которых есть ссылка на GitLab, но репозиторий не существует.

Использование:
    python3 check-gitlab-exists.py --parent 28324 --parent 32968 --parent 25624 --parent 30501
    python3 check-gitlab-exists.py --query "adtech" --query "dsp"
    python3 check-gitlab-exists.py --output json
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Dict, List, Optional, Tuple

REPO_ROOT = os.environ.get('PWD') or os.getcwd()
ENV_FILE = os.path.join(REPO_ROOT, '.env')
FINEDOG_API_BASE = 'https://finedog.tinkoff.ru/api/integration'
GITLAB_API_BASE = 'https://gitlab.tcsbank.ru/api/v4'


def get_tokens() -> Tuple[Optional[str], Optional[str]]:
    """Извлечение токенов из .env файла."""
    if not os.path.exists(ENV_FILE):
        return None, None

    finedog_token = None
    gitlab_token = None

    with open(ENV_FILE, 'r') as f:
        for line in f:
            if line.startswith('token=Bearer '):
                finedog_token = line.strip().replace('token=Bearer ', '')
            elif line.startswith('gitlab_pat_token='):
                gitlab_token = line.strip().replace('gitlab_pat_token=', '')

    return finedog_token, gitlab_token


def get_units(finedog_token: str, parent_ids: Optional[List[int]] = None, 
              queries: Optional[List[str]] = None) -> Dict[int, dict]:
    """Получение юнитов из Finedog API."""
    headers = {'Authorization': f'Bearer {finedog_token}'}
    unit_ids = set()

    # Поиск по parent IDs
    if parent_ids:
        for parent_id in parent_ids:
            try:
                data = json.dumps({"parentIds": [parent_id], "page": 1, "pageSize": 200}).encode('utf-8')
                req = urllib.request.Request(f'{FINEDOG_API_BASE}/v1/units/list', data=data, 
                                            headers={**headers, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=30) as response:
                    result = json.loads(response.read().decode('utf-8'))
                    for unit in result.get('items', []):
                        if unit.get('kind') in ['system', 'subsystem', 'component']:
                            unit_ids.add(unit['id'])
            except Exception as e:
                print(f"Warning: Error getting parent {parent_id}: {e}", file=sys.stderr)

    # Поиск по query
    if queries:
        for query in queries:
            try:
                data = json.dumps({"query": query, "page": 1, "pageSize": 200}).encode('utf-8')
                req = urllib.request.Request(f'{FINEDOG_API_BASE}/v1/units/list', data=data,
                                            headers={**headers, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=30) as response:
                    result = json.loads(response.read().decode('utf-8'))
                    for unit in result.get('items', []):
                        if unit.get('kind') in ['system', 'subsystem', 'component']:
                            unit_ids.add(unit['id'])
            except Exception as e:
                print(f"Warning: Error searching '{query}': {e}", file=sys.stderr)

    # Получение деталей каждого юнита
    print(f"  Получение деталей {len(unit_ids)} юнитов...", file=sys.stderr)
    units = {}
    for unit_id in unit_ids:
        try:
            req = urllib.request.Request(f'{FINEDOG_API_BASE}/v1/units/{unit_id}', headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                unit = json.loads(response.read().decode('utf-8'))
                if unit.get('gitlab'):
                    units[unit_id] = unit
        except Exception:
            pass

    return units


def check_gitlab_repo(gitlab_token: str, project_path: str) -> Tuple[bool, str]:
    """
    Проверка существования репозитория в GitLab.
    Returns: (exists, status_message)
    """
    import urllib.parse
    encoded_path = urllib.parse.quote(project_path, safe='')
    url = f'{GITLAB_API_BASE}/projects/{encoded_path}'
    headers = {'PRIVATE-TOKEN': gitlab_token}

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data.get('archived'):
                return True, f"EXISTS (archived)"
            return True, "EXISTS"
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False, "NOT_FOUND (404)"
        elif e.code == 403:
            return False, "ACCESS_DENIED (403)"
        else:
            return False, f"ERROR ({e.code})"
    except Exception as e:
        return False, f"ERROR ({str(e)})"


def main():
    parser = argparse.ArgumentParser(description='Проверка существования GitLab репозиториев')
    parser.add_argument('--parent', type=int, action='append', dest='parent_ids',
                        help='Parent unit ID (можно указать несколько)')
    parser.add_argument('--query', action='append', dest='queries',
                        help='Search query (можно указать несколько)')
    parser.add_argument('--output', choices=['table', 'json'], default='table',
                        help='Output format')
    args = parser.parse_args()

    if not args.parent_ids and not args.queries:
        # По умолчанию проверяем все RTB tenant'ы
        args.parent_ids = [28324, 32968, 25624, 30501, 5225]
        print("No criteria specified, checking all RTB tenants...", file=sys.stderr)

    finedog_token, gitlab_token = get_tokens()
    if not finedog_token:
        print("Error: No Finedog token", file=sys.stderr)
        sys.exit(1)
    if not gitlab_token:
        print("Error: No GitLab token", file=sys.stderr)
        sys.exit(1)

    # Получаем юниты
    print("Fetching units from Finedog...", file=sys.stderr)
    units = get_units(finedog_token, args.parent_ids, args.queries)
    print(f"Found {len(units)} units with GitLab URLs", file=sys.stderr)

    # Проверяем репозитории
    print("Checking GitLab repositories...", file=sys.stderr)
    not_found = []
    exists = []
    archived = []

    for unit_id, unit in units.items():
        gitlab_url = unit.get('gitlab', '')
        if not gitlab_url:
            continue

        project_path = gitlab_url.replace('https://gitlab.tcsbank.ru/', '')
        repo_exists, status = check_gitlab_repo(gitlab_token, project_path)

        unit_info = {
            'unit_id': unit_id,
            'name': unit.get('name', 'unknown'),
            'kind': unit.get('kind', 'unknown'),
            'gitlab': gitlab_url,
            'project_path': project_path,
            'status': status
        }

        if not repo_exists:
            not_found.append(unit_info)
        elif 'archived' in status.lower():
            archived.append(unit_info)
        else:
            exists.append(unit_info)

    # Вывод результатов
    if args.output == 'json':
        report = {
            'summary': {
                'total_checked': len(units),
                'exists': len(exists),
                'archived': len(archived),
                'not_found': len(not_found)
            },
            'not_found': not_found,
            'archived': archived,
            'exists': exists
        }
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print("=" * 100)
        print("           GITLAB REPOSITORY EXISTENCE CHECK REPORT")
        print("=" * 100)
        print()
        print(f"  Всего проверено:     {len(units)}")
        print(f"  Существуют:          {len(exists)}")
        print(f"  Заархивированы:      {len(archived)}")
        print(f"  Не найдены:          {len(not_found)}")
        print()

        if not_found:
            print("-" * 100)
            print("❌ ЮНИТЫ С НЕСУЩЕСТВУЮЩИМИ РЕПОЗИТОРИЯМИ:")
            print("-" * 100)
            print(f"{'Unit ID':<10} {'Name':<40} {'GitLab Repository'}")
            print("-" * 100)
            for unit in sorted(not_found, key=lambda x: x['project_path']):
                print(f"❌ {unit['unit_id']:<8} {unit['name']:<40} {unit['project_path']}")
        else:
            print("✅ Все репозитории существуют!")

        if archived:
            print()
            print("-" * 100)
            print("📦 ЮНИТЫ С ЗААРХИВИРОВАННЫМИ РЕПОЗИТОРИЯМИ:")
            print("-" * 100)
            print(f"{'Unit ID':<10} {'Name':<40} {'GitLab Repository'}")
            print("-" * 100)
            for unit in sorted(archived, key=lambda x: x['project_path']):
                print(f"📦 {unit['unit_id']:<8} {unit['name']:<40} {unit['project_path']}")

        print()
        print("=" * 100)


if __name__ == '__main__':
    main()
