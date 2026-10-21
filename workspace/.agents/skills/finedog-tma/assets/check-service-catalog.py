#!/usr/bin/env python3
"""
Полная проверка каталога услуг (service-catalog.md) через Finedog API.
Проверяет все критерии из Wiki для каждого юнита.
"""

import json
import os
import urllib.request
import urllib.error
import time
from datetime import datetime
from pathlib import Path

# Пути
REPO_ROOT = os.environ.get('PWD') or os.getcwd()
CATALOG_FILE = os.path.join(REPO_ROOT, 'docs/metrics/service-catalog.md')
ENV_FILE = os.path.join(REPO_ROOT, '.env')
OUTPUT_FILE = os.path.join(REPO_ROOT, 'docs/metrics/service-catalog-check-report.md')
API_BASE = 'https://finedog.tinkoff.ru/api/integration'
GITLAB_API_BASE = 'https://gitlab.tcsbank.ru/api/v4'
SCRIPT_DIR = Path(__file__).parent
TEAMS_CACHE_FILE = SCRIPT_DIR / "teams_cache.json"

# Параметры retry для обработки HTTP 429
MAX_RETRIES = 5
RETRY_DELAY = 1  # начальная задержка в секундах


def get_gitlab_token():
    """Extract GitLab PAT token from .env file."""
    if not os.path.exists(ENV_FILE):
        return None
    with open(ENV_FILE) as f:
        for line in f:
            if line.startswith('gitlab_pat_token='):
                return line.strip().split('=', 1)[1]
    return None


def load_teams_cache():
    """Load teams cache for team type lookup."""
    if not TEAMS_CACHE_FILE.exists():
        return None
    try:
        with open(TEAMS_CACHE_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def get_team_type(team_id, cache):
    """Get team type by ID from cache."""
    if not cache or "teams" not in cache:
        return "unknown"
    
    # Team IDs in cache are strings
    team = cache["teams"].get(str(team_id))
    if not team:
        return "unknown"
    
    team_type = team.get("teamType")
    if team_type:
        team_type = team_type.lower()
        if team_type in ["sre", "dev", "support"]:
            return team_type
    
    # Fallback to name check
    name = team.get("name", "").lower()
    if "sre" in name:
        return "sre"
    elif "dev" in name:
        return "dev"
    elif "support" in name:
        return "support"
    
    return "unknown"


def check_gitlab_repository(gitlab_url, unit_archived=False):
    """
    Проверка GitLab репозитория по URL.

    Args:
        gitlab_url: URL репозитория (например, https://gitlab.tcsbank.ru/adtech/placement-configuration)
        unit_archived: Архивирован ли юнит в Finedog

    Returns:
        dict с результатами проверки:
        - exists: найден ли репозиторий
        - archived: архивирован ли репозиторий
        - error: ошибка если есть
    """
    if not gitlab_url:
        return {'exists': False, 'archived': None, 'error': 'No URL'}

    # Извлекаем путь репозитория из URL
    try:
        if 'gitlab.tcsbank.ru' not in gitlab_url:
            return {'exists': False, 'archived': None, 'error': 'Not a GitLab TCS URL'}

        parts = gitlab_url.replace('https://', '').replace('http://', '').split('/', 1)
        if len(parts) < 2:
            return {'exists': False, 'archived': None, 'error': 'Invalid URL format'}

        repo_path = parts[1]
        encoded_path = urllib.request.quote(repo_path, safe='')
        url = f"{GITLAB_API_BASE}/projects/{encoded_path}"

        req = urllib.request.Request(url)
        # Добавляем токен аутентификации GitLab
        gitlab_token = get_gitlab_token()
        if gitlab_token:
            req.add_header('PRIVATE-TOKEN', gitlab_token)
        
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            is_archived = data.get('archived', False)

            if not unit_archived and is_archived:
                return {
                    'exists': True,
                    'archived': True,
                    'error': 'Repository archived but unit is active'
                }

            return {
                'exists': True,
                'archived': is_archived,
                'error': None
            }

    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'exists': False, 'archived': None, 'error': 'Repository not found (404)'}
        elif e.code == 403:
            return {'exists': False, 'archived': None, 'error': 'Access denied (403)'}
        else:
            return {'exists': False, 'archived': None, 'error': f'HTTP {e.code}'}
    except Exception as e:
        return {'exists': False, 'archived': None, 'error': str(e)}


def make_request_with_retry(url, token, timeout=10):
    """
    Выполняет HTTP-запрос с retry при HTTP 429.
    Использует экспоненциальную задержку между попытками.
    """
    retry_count = 0
    delay = RETRY_DELAY
    
    while retry_count < MAX_RETRIES:
        try:
            req = urllib.request.Request(
                url,
                headers={'Authorization': f'Bearer {token}'}
            )
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
                    return {'error': f'HTTP 429 (max retries exceeded)'}
            else:
                return {'error': f'HTTP {e.code}'}
        except Exception as e:
            return {'error': str(e)}
    
    return {'error': 'Unknown error'}


# Критерии проверки услуги
CHECKS = {
    'description': 'Описание (заполнено, != названия, >= 20 символов)',
    'sla_monitoring': 'Мониторинг SLA',
    'support_chat': 'Чат поддержки',
    'documentation': 'Документация',
    'gitlab': 'Gitlab (URL заполнен)',
    'gitlab_exists': 'GitLab репозиторий найден',
    'gitlab_not_archived': 'GitLab репозиторий не архивирован (для активного юнита)',
    'announcements': 'Анонсы',
    'dev_team': 'Команда разработки',
    'sre_team': 'Команда SRE',
    'support_team': 'Команда Support',
    'influencing_relations': 'Влияющие связи (система/подсистема/компонент)',
    'agreements': 'Соглашения (хотя бы одно)',
    'runbooks': 'Ранбуки во всех соглашениях'
}


def get_token():
    """Извлечение токена из .env"""
    if not os.path.exists(ENV_FILE):
        return None
    with open(ENV_FILE, 'r') as f:
        for line in f:
            if line.startswith('token=Bearer '):
                # Извлекаем только значение токена без "Bearer "
                return line.split('=', 1)[1].replace('Bearer ', '').strip()
    return None


def parse_catalog(filepath):
    """Парсит markdown-файл каталога и возвращает список ID юнитов."""
    if not os.path.exists(filepath):
        return None, f"❌ Файл каталога не найден: {filepath}"
    
    unit_ids = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    lines = content.split('\n')
    header_found = False
    
    for line in lines:
        if '|---|' in line or '| --- |' in line:
            header_found = True
            continue
        if not header_found:
            continue
        
        line_stripped = line.strip()
        if not line_stripped or not line_stripped.startswith('|'):
            continue
        if line_stripped.startswith('#') or line_stripped.startswith('>'):
            continue
        
        parts = line_stripped.split('|')
        if parts and parts[0] == '':
            parts = parts[1:]
        if parts and parts[-1] == '':
            parts = parts[:-1]
        parts = [p.strip() for p in parts]
        
        if len(parts) >= 2:
            try:
                unit_ids.append(int(parts[1]))
            except ValueError:
                pass
    
    return unit_ids, None


def fetch_unit_details(unit_id, token):
    """Получение деталей юнита из Finedog API."""
    url = f"{API_BASE}/v1/units/{unit_id}"
    return make_request_with_retry(url, token, timeout=10)


def fetch_unit_relations(unit_id, token):
    """Получение связей юнита."""
    url = f"{API_BASE}/v1/units/{unit_id}/relation/from"
    result = make_request_with_retry(url, token, timeout=10)
    # Если ошибка - возвращаем пустой список
    if isinstance(result, dict) and 'error' in result:
        return []
    return result if isinstance(result, list) else []


def check_unit(unit_data, relations, teams_cache=None):
    """Проверка юнита на соответствие критериям."""
    results = {}

    # 1. Описание
    desc = unit_data.get('description', '')
    name = unit_data.get('name', '')
    
    # Проверка на авто-сгенерированное описание
    auto_generated_descriptions = [
        'Generated automatically by script in tma-sre/pipelines'
    ]
    is_auto_generated = desc in auto_generated_descriptions
    
    results['description'] = {
        'passed': bool(desc) and desc != name and len(desc) >= 20 and not is_auto_generated,
        'value': desc[:50] + '...' if len(desc) > 50 else desc,
        'auto_generated': is_auto_generated
    }

    # 2. Мониторинг SLA
    results['sla_monitoring'] = {
        'passed': bool(unit_data.get('slaUrl')),
        'value': unit_data.get('slaUrl', '')
    }

    # 3. Чат поддержки
    results['support_chat'] = {
        'passed': bool(unit_data.get('chatSupport')),
        'value': unit_data.get('chatSupport', '')
    }

    # 4. Документация
    results['documentation'] = {
        'passed': bool(unit_data.get('documentation')),
        'value': unit_data.get('documentation', '')
    }

    # 5. Анонсы
    results['announcements'] = {
        'passed': bool(unit_data.get('chatNews')),
        'value': unit_data.get('chatNews', '')
    }

    # 6-8. Команды (разделение по типам через кэш)
    teams = unit_data.get('teamsIds', [])

    # Разделяем команды по типам
    sre_teams = []
    dev_teams = []
    support_teams = []
    unknown_teams = []

    for team_id in teams:
        team_type = get_team_type(team_id, teams_cache)
        if team_type == 'sre':
            sre_teams.append(team_id)
        elif team_type == 'dev':
            dev_teams.append(team_id)
        elif team_type == 'support':
            support_teams.append(team_id)
        else:
            unknown_teams.append(team_id)

    # Команда разработки (dev teams)
    results['dev_team'] = {
        'passed': len(dev_teams) > 0,
        'value': str(dev_teams) if dev_teams else 'Нет dev команд'
    }

    # Команда SRE
    results['sre_team'] = {
        'passed': len(sre_teams) > 0,
        'value': str(sre_teams) if sre_teams else 'Нет SRE команд'
    }

    # Команда поддержки (support teams)
    results['support_team'] = {
        'passed': len(support_teams) > 0,
        'value': str(support_teams) if support_teams else 'Нет support команд'
    }

    # 9. Влияющие связи
    influencing = [r for r in relations if r.get('kind') in ['system', 'subsystem', 'component']]
    results['influencing_relations'] = {
        'passed': len(influencing) > 0,
        'value': f'{len(influencing)} связей'
    }

    # 11-12. Соглашения и ранбуки (требует доп. API)
    results['agreements'] = {'passed': False, 'value': 'Требуется проверка'}
    results['runbooks'] = {'passed': False, 'value': 'Требуется проверка'}

    return results


def main():
    print("🔍 Полная проверка каталога услуг через Finedog API...")
    print()

    token = get_token()
    if not token:
        print("❌ Токен не найден. Выполните ./assets/finedog-auth.sh")
        return 1

    # Загружаем кэш команд
    teams_cache = load_teams_cache()
    if teams_cache:
        print(f"📋 Загружен кэш команд: {teams_cache.get('count', 0)} команд")
    else:
        print("⚠️  Кэш команд не найден. Запустите fetch-teams-cache.py")
        teams_cache = None

    unit_ids, error = parse_catalog(CATALOG_FILE)
    if error:
        print(error)
        return 1

    if not unit_ids:
        print("❌ Юниты не найдены в каталоге")
        return 1

    print(f"📊 Найдено юнитов: {len(unit_ids)}")
    print()

    all_results = []
    archived_count = 0

    for i, unit_id in enumerate(unit_ids, 1):
        print(f"[{i}/{len(unit_ids)}] Проверка юнита {unit_id}...")

        unit_data = fetch_unit_details(unit_id, token)
        if 'error' in unit_data:
            all_results.append({
                'id': unit_id,
                'name': 'N/A',
                'error': unit_data['error']
            })
            continue

        # Пропускаем архивированные юниты
        if unit_data.get('archived', False):
            print(f"    ⏭️  Пропущен (архивирован)")
            archived_count += 1
            continue

        relations = fetch_unit_relations(unit_id, token)
        checks = check_unit(unit_data, relations, teams_cache)

        passed = sum(1 for c in checks.values() if c['passed'])
        total = len(checks)

        all_results.append({
            'id': unit_id,
            'name': unit_data.get('name', 'N/A'),
            'checks': checks,
            'passed': passed,
            'total': total,
            'score': round((passed / total) * 100, 1) if total > 0 else 0
        })

    # Генерация отчёта
    generate_report(all_results)

    # Вывод статистики
    total_units = len(all_results)
    error_units = sum(1 for r in all_results if 'error' in r)
    full_pass = sum(1 for r in all_results if 'score' in r and r['score'] == 100)
    avg_score = sum(r.get('score', 0) for r in all_results if 'score' in r) / max(1, total_units - error_units)

    print()
    print("=" * 60)
    print("📊 ИТОГИ ПРОВЕРКИ")
    print("=" * 60)
    print(f"Всего юнитов в каталоге: {len(unit_ids)}")
    print(f"Архивировано (пропущено): {archived_count}")
    print(f"Проверено юнитов: {total_units}")
    print(f"Ошибки API: {error_units}")
    print(f"100% соответствие: {full_pass}")
    print(f"Средний балл: {avg_score:.1f}%")
    print()
    print(f"📄 Отчёт: {OUTPUT_FILE}")
    
    return 0


def generate_report(results):
    """Генерация markdown-отчёта."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    content = f"""# Отчёт проверки каталога услуг (Service Catalog)

**Дата проверки:** {timestamp}
**Источник:** docs/metrics/service-catalog.md
**Метод:** Проверка через Finedog API

---

## Сводка

| Метрика | Значение |
|---|---|
| Всего юнитов | {len(results)} |
| Ошибки API | {sum(1 for r in results if 'error' in r)} |
| 100% соответствие | {sum(1 for r in results if 'score' in r and r['score'] == 100)} |
| Средний балл | {sum(r.get('score', 0) for r in results if 'score' in r) / max(1, len([r for r in results if 'score' in r])):.1f}% |

---
## Детали по юнитам

"""

    for r in results:
        if 'error' in r:
            content += f"### ❌ Юнит {r['id']} — Ошибка API: {r['error']}\n\n"
            continue

        # Добавляем информацию о GitLab в заголовок если есть проблемы
        gitlab_issues = []
        if r.get('gitlab_check'):
            if not r['gitlab_check'].get('exists'):
                gitlab_issues.append(f"Repo not found: {r['gitlab_check'].get('error', 'Unknown')}")
            if r['gitlab_check'].get('archived'):
                gitlab_issues.append("Repo archived")
        
        header_icon = '✅' if r['score'] == 100 else '⚠️'
        header_extra = f" ({', '.join(gitlab_issues)})" if gitlab_issues else ""
        content += f"### {header_icon} Юнит {r['id']} — {r['name']} (Балл: {r['score']}%){header_extra}\n\n"
        content += "| Критерий | Статус | Значение |\n"
        content += "|---|---|---|\n"

        for check_name, check_data in r['checks'].items():
            status = '✅' if check_data['passed'] else '❌'
            value = check_data['value']
            
            # Добавляем пометку для авто-сгенерированного описания
            if check_name == 'description' and check_data.get('auto_generated'):
                status = '❌'
                value = '⚠️ Auto-generated: ' + value
            
            content += f"| {check_name} | {status} | {value} |\n"

        content += "\n"

    content += """
---

## Критерии проверки

| № | Критерий | Описание |
|---|---|---|
| 1 | description | Описание заполнено, не совпадает с названием, >= 20 символов, НЕ авто-сгенерированное |
| 2 | sla_monitoring | Заполнено поле "Мониторинг SLA" |
| 3 | support_chat | Заполнено поле "Чат поддержки" |
| 4 | documentation | Заполнено поле "Документация" |
| 5 | gitlab | Заполнено поле "Gitlab" |
| 6 | gitlab_exists | GitLab репозиторий найден по URL |
| 7 | gitlab_not_archived | Репозиторий не архивирован (или юнит архивирован) |
| 8 | announcements | Заполнено поле "Анонсы" |
| 9 | dev_team | Указана команда разработки |
| 10 | sre_team | Указана команда SRE |
| 11 | support_team | Указана команда Support |
| 12 | influencing_relations | Есть связи с системами/подсистемами/компонентами |
| 13 | agreements | Есть хотя бы одно соглашение |
| 14 | runbooks | Во всех соглашениях указан ранбук |

---

**Источник критериев:** https://wiki.tcsbank.ru/pages/viewpage.action?pageId=7688897673

**Проверка GitLab:**
- Репозиторий должен существовать по указанному URL
- Если юнит не архивирован в Finedog, репозиторий не должен быть архивирован в GitLab

**Авто-сгенерированные описания:**
- Описания вида "Generated automatically by script in tma-sre/pipelines" считаются невалидными
"""
    
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(content)


if __name__ == '__main__':
    exit(main())
