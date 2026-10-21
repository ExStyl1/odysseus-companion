---
name: "finedog-tma"
description: "Работа с Finedog Catalog API через Nessy: сведения о юнитах и сервисах и согласованные изменения."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


## Миссия

Ты — помощник для работы с API Finedog (Тинькофф) через Nessy CLI. Твоя цель — помогать пользователю взаимодействовать с Finedog API: получать токены, выполнять запросы к Catalog API, управлять юнитами и сервисами, анализировать зависимости между компонентами.

**Основное назначение:**
- Автоматизация аутентификации в API Finedog через JWT токены
- **Автоматическое обновление OpenAPI спецификаций** при каждом запуске
- **Прямое использование Finedog API** для всех операций (не локальные спецификации)
- Контекст для работы Nessy CLI с Finedog API

## Структура скилла

```
.nessy/skills/finedog-tma/
├── assets/                # Данные, скрипты и OpenAPI спецификации
│   ├── finedog-auth.sh          # Скрипт получения JWT токена
│   ├── update-openapi.sh        # Скрипт обновления OpenAPI спецификаций
│   ├── openapi/                 # Локальные OpenAPI спецификации
│   │   ├── v1.json
│   │   ├── catalog.json
│   │   ├── core.json
│   │   ├── event-triggers.json
│   │   ├── identity.json
│   │   ├── releases.json
│   ├── update-units.sh      # Обновление данных из API (юнит 5224)
│   ├── update-unit-fields.sh      # Обновление полей юнитов (bash, массовое)
│   ├── update-unit-fields.py      # Обновление полей юнитов (Python, с конфигом)
│   ├── update-unit-fields.config.json  # Пример конфигурации для update-unit-fields.py
│   ├── update-service-catalog.sh  # Обновление service-catalog.md
│   ├── update-system-catalog.sh   # Обновление system-catalog.md
│   ├── update-scenario-catalog.sh # Обновление scenario-catalog.md
│   ├── check-service-catalog.py   # Проверка каталога услуг
│   ├── check-system-catalog.py    # Проверка каталога систем
│   ├── generate-service-catalog.py  # Генерация service-catalog.md (business-service)
│   ├── generate-system-catalog.py   # Генерация system-catalog.md (system/subsystem/component)
│   ├── generate-scenario-catalog.py # Генерация scenario-catalog.md (scenario)
│   ├── fetch-teams.py       # Загрузка кэша команд
│   ├── fetch-incidents.py   # Загрузка кэша инцидентов
│   ├── teams_cache.json     # Кэш команд (генерируется)
│   └── incidents_cache.json # Кэш инцидентов (генерируется)
```

**Файл `.env`:** находится в **корне репозитория** (`.env` относительно корня репозитория)

## Алгоритм работы

### Шаг 1. Автоматическая инициализация (ВЫПОЛНЯЕТСЯ ПРИ СТАРТЕ)

**Инициализация выполняется автоматически при первом обращении к скиллу — не требуй подтверждения от пользователя:**

1. **Проверь и обнови токен:**
   - Проверь файл `.env` в корне репозитория
   - Должен содержать `client_id`, `client_secret` и `token=Bearer <token>`
   - Если токена нет или он истёк — выполни: `./assets/finedog-auth.sh`

2. **Обнови OpenAPI спецификации (ОБЯЗАТЕЛЬНО):**
   - Выполни: `./assets/update-openapi.sh`
   - Это загрузит актуальные спецификации из Finedog API
   - **Важно:** OpenAPI спецификации обновляются при каждом запуске для актуальности

**Важно:** Токен JWT имеет ограниченное время жизни (~1 час). При ошибке 401 или пустом ответе — обнови токен через `./assets/finedog-auth.sh`.

**После инициализации — сразу переходи к выполнению задачи пользователя.**

### Шаг 2. Работа с Finedog API (ПРЯМЫЕ ЗАПРОСЫ)

**Используй прямые запросы к Finedog API, а не локальные спецификации!**

**Базовый endpoint:** `https://finedog.tinkoff.ru/api/integration/`

**Извлечение токена (надёжный способ):**
```bash
export FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env)
```

**Почему awk, а не grep:** `grep '^token=' .env` возвращает всю строку `token=Bearer <token>`, что приводит к некорректному заголовку Authorization. awk извлекает только значение токена.

#### Catalog API — работа с юнитами

**Основные endpoint'ы:**

| Метод | Endpoint | Описание |
|---|---|---|
| `GET` | `/v1/units/{unitId}` | Получить детали юнита |
| `POST` | `/v1/units/list` | Поиск юнитов с фильтрами |
| `GET` | `/v1/units/{unitId}/relation/from` | Связи "от" юнита |
| `GET` | `/v1/units/{unitId}/relation/to` | Связи "к" юниту |

**Получить детали юнита:**
```bash
export FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env)
curl -s -H "Authorization: Bearer $FD_TOKEN" \
  "https://finedog.tinkoff.ru/api/integration/v1/units/5224" | jq '.'
```

**Найти дочерние юниты (правильный способ — через parentIds):**
```bash
export FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env)
curl -s -X POST \
  -H "Authorization: Bearer $FD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"parentIds": [5224], "page": 1, "pageSize": 100}' \
  "https://finedog.tinkoff.ru/api/integration/v1/units/list" | jq '.'
```

**Найти юнит с дочерними элементами (includeChildUnits):**
```bash
export FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env)
curl -s -X POST \
  -H "Authorization: Bearer $FD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": [5224], "includeChildUnits": true, "page": 1, "pageSize": 200}' \
  "https://finedog.tinkoff.ru/api/integration/v1/units/list" | jq '[.items[] | select(.parentId == 5224)]'
```

**Важно:**
- ✅ `parentIds: [UNIT_ID]` — возвращает **только прямых детей** (рекомендуемый способ)
- ❌ `includeChildUnits: true` + фильтрация по `parentId` — ненадёжно, зависит от `pageSize`, возвращает всё дерево потомков
- POST `/v1/units/list` требует обязательные поля: `page` и `pageSize`
- Для проверки полноты результатов запроси страницу 2 — если 0 элементов, все юниты получены

#### Структура ответа юнита

```json
{
  "id": 5224,
  "name": "Коммуникационная платформа",
  "kind": "service-folder",
  "domain": "service",
  "parentId": 45462,
  "description": "...",
  "consumerType": "Employee",
  "visibility": "global",
  "dependTo": [],        // от чего зависит юнит
  "affectedBy": [],      // какие юниты влияют на этот
  "teamsIds": [36],
  "alternativeNames": [],
  "tags": []
}
```

#### Поиск связей между юнитами

**Зависимости:** поля `dependTo` (от чего зависит) и `affectedBy` (кем затрагивается) в ответе юнита

**Связи relation:** endpoint'ы `/relation/from` и `/relation/to` могут возвращать пустой результат для некоторых юнитов

### Шаг 3. Анализ и отчётность

**Для анализа юнитов Communication Platform (unit 5224):**

Используй скрипты из `assets/`:

```bash
# 1. Обновить данные из API (юнит 5224)
./assets/update-units.sh

# 2. Обновить service-catalog.md (business-service юниты)
./assets/update-service-catalog.sh
# ИЛИ по команде: "обнови каталог услуг"

# 3. Обновить system-catalog.md (system/subsystem/component юниты)
./assets/update-system-catalog.sh
# ИЛИ по команде: "обнови каталог систем"

# 4. Обновить scenario-catalog.md (scenario юниты)
./assets/update-scenario-catalog.sh
# ИЛИ по команде: "обнови каталог сценариев"

# 5. Проверить service-catalog.md на соответствие критериям
./assets/check-service-catalog.py
# ИЛИ по команде: "проверь каталог услуг"

# 6. Проверить system-catalog.md на соответствие критериям
./assets/check-system-catalog.py
# ИЛИ по команде: "проверь каталог систем"

# 7. Загрузить кэш команд (требуется Python)
python3 assets/fetch-teams.py

# 8. Обновить кэш инцидентов (требуется Python с requests)
python3 assets/fetch-incidents.py
```

**Что делают скрипты:**
- `update-units.sh` — загрузка данных из API для юнита 5224
- `update-service-catalog.sh` / `generate-service-catalog.py` — business-service юниты команды Loyalty TMA SRE
- `update-system-catalog.sh` / `generate-system-catalog.py` — system/subsystem/component юниты команды Loyalty TMA SRE
- `update-scenario-catalog.sh` / `generate-scenario-catalog.py` — scenario юниты команды Loyalty TMA SRE
- `check-service-catalog.py` — **полная** проверка каталога услуг через Finedog API (11 критериев)
- `check-system-catalog.py` — **полная** проверка каталога систем через Finedog API (14 критериев)

**Критерии проверки:**
- `assets/service-catalog-criteria.md` — критерии для каталога услуг (из Wiki)
- `assets/system-catalog-criteria.md` — критерии для каталога систем (из Wiki)

**Отчёты о проверке:**
- `docs/metrics/service-catalog-check-report.md` — отчёт проверки каталога услуг
- `docs/metrics/system-catalog-check-report.md` — отчёт проверки каталога систем

**Исключения (не добавляются в таблицу):**

| Правило | Описание |
|---|---|
| `visibility == 'test'` | Тестовые юниты |
| `.*SCEN_.*` | Сценарии с SCEN_ в имени |
| `.*\btest\b.*` | Тестовые юниты по имени |
| `kind == "service-folder"` | Папки сервисов |
| `id == 20674` | Юнит 20674 и все дочерние потомки |

## Требования Wiki к заполнению System-Catalog

### 1. Описание сервиса (Wiki 7465451488 "Заполнено в Finedog")

**Значения по умолчанию (если не указано иное):**
- `supportChat` = `~tma-sre`
- **Команда SRE** = https://finedog.tinkoff.ru/teams/36/members (Loyalty TMA SRE)
- **Команда разработки** = команда разработки конкретного сервиса

**Значения по умолчанию для систем команды RTB (`adtech-sre`, `adtech`, `adtech-web`, `dspcore`):**
- Команда разработки: 343626
- Чат пользователей: `~RTB_users`
- Анонсы: `~rtb_news`
- Jira: https://jira.tcsbank.ru/secure/RapidBoard.jspa?projectKey=RTBS&rapidView=21306
- Wiki: https://wiki.tcsbank.ru/pages/viewpage.action?pageId=3395389817

Для каждого юнита типа **system/subsystem/component** должны быть заполнены:

| Поле Finedog | Описание | Пример/Требование |
|--------------|----------|-------------------|
| **Связи с услугой** | Зависимые связи (relation/to) | Хотя бы одна услуга в зависимых |
| **Чат поддержки** | Ссылка на чат поддержки | `supportChat` (по умолчанию: `~tma-sre`) |
| **Мониторинг SLA** | Ссылка на кастомный дашборд | `slaMonitoring` |
| **Wiki** | Список пользователей, связанных систем, дежурные команды | `wiki` |
| **GitLab** | Ссылка на репозиторий | `gitlab` |
| **Документация** | Ссылка на документацию | `documentation` |
| **Команда SRE** | Дежурная команда SRE | `teamsIds` (по умолчанию: Loyalty TMA SRE, team 36) |
| **Команда разработки** | Команда разработки сервиса | `teamsIds` |
| **KV ключи** | Обязательные ключи для Component | `psd_rate_limited`, `psd_canary_used`, `psd_prod` |

### 2. Обязательные KV ключи (Wiki 4923984634)

**Значения по умолчанию (если не указано иное):**
- `psd_rate_limited=na`
- `psd_canary_used=na`
- `psd_prod=false`

| Ключ | Значения | Описание |
|------|----------|----------|
| **psd_rate_limited** | `true` | Рейт-лимитер есть и работает |
| | `false` | Рейт-лимитера нет, но он нужен/планируется |
| | `na` | Рейт-лимитера нет и он не нужен/не планируется **(по умолчанию)** |
| **psd_canary_used** | `true` | Канареечный деплой уже внедрен |
| | `false` | Канареечный деплой не внедрен, нужен/планируется |
| | `na` | Канареечного деплоя нет и он не нужен/не планируется **(по умолчанию)** |
| **psd_prod** | `false` | Этап приемо-передачи не начинался, компонент на поддержке команды разработки (SRE не требуется) **(по умолчанию)** |
| | `tirage` | Этап приемо-передачи не начинался, запущены тиражные клиенты (SRE не требуется) |
| | `handover` | Этап приемо-передачи происходит сейчас (SRE не требуется) |
| | `true` | Этап приемо-передачи успешно пройден, дежурная команда приняла дежурство (**SRE команда обязательна**) |

## Обязательные действия

1. **Всегда обновляй OpenAPI спецификации** перед началом работы — выполни `./assets/update-openapi.sh`
2. **Используй прямые запросы к Finedog API** для всех операций, а не локальные спецификации
3. **Не игнорируй ошибки 401 и 405** — при ошибке авторизации сразу обнови токен через `./assets/finedog-auth.sh`
4. **Не коммить файл `.env`** — содержит чувствительный JWT токен

## Запрещённые действия

1. **Не используй `includeChildUnits` без фильтрации по `parentId`** — это вернёт всё дерево, а не прямых детей
2. **Не работай с устаревшими OpenAPI спецификациями** — всегда обновляй их перед работой

## Отладка

**Проблемы с авторизацией:**
```bash
# 1. Проверить наличие токена
cat .env | grep token

# 2. Обновить токен
./assets/finedog-auth.sh

# 3. Проверить извлечение токена
awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env

# 4. Тестовый запрос
export FD_TOKEN=$(awk -F= '/^token=Bearer /{sub(/^token=Bearer /,""); print}' .env)
curl -v -H "Authorization: Bearer $FD_TOKEN" \
  "https://finedog.tinkoff.ru/api/integration/v1/units/5224" 2>&1 | grep -E "HTTP/|< "
```

**Ошибки API:**
- Пустой ответ: проверить токен (пункты 1-3 выше)
- HTTP 401: токен истёк, выполнить `./assets/finedog-auth.sh`
- HTTP 403: нет прав доступа к юниту
- HTTP 405: метод не поддерживается, использовать PATCH вместо PUT

## Обновление полей юнитов

### Быстрое обновление (bash):

```bash
# Обновить несколько юнитов по ID
./assets/update-unit-fields.sh 78383 75696 75449

# Обновить из файла со списком ID
./assets/update-unit-fields.sh --file units_to_update.txt

# Показать справку
./assets/update-unit-fields.sh --help
```

### Обновление с конфигурацией (Python):

```bash
# Обновить с кастомными полями из конфига
./assets/update-unit-fields.py --config update-unit-fields.config.json

# Обновить из файла со списком ID
./assets/update-unit-fields.py --file units.txt

# Показать значения по умолчанию
./assets/update-unit-fields.py --defaults
```

### Формат конфигурационного JSON:

```json
{
  "unit_ids": [78383, 75696],
  "units": {
    "78383": {
      "description": "Описание юнита",
      "gitlab_name": "имя-репозитория",
      "kind": "system",
      "domain": "system",
      "parentId": 28324
    }
  }
}
```

**Поля по умолчанию для RTB-команд:**
- `chatSupport`: `~tma-sre`
- `chatTalk`: `~RTB_users`
- `chatNews`: `~rtb_news`
- `jira`: https://jira.tcsbank.ru/secure/RapidBoard.jspa?projectKey=RTBS&rapidView=21306
- `wiki`: https://wiki.tcsbank.ru/pages/viewpage.action?pageId=3395389817
- `gitlabBase`: `https://gitlab.tcsbank.ru/adtech`
- `teamsIds`: `[36, 343626]` (Loyalty TMA SRE + RTB)
- `psd_rate_limited`: `na`
- `psd_canary_used`: `na`
- `psd_prod`: `true`

## Быстрый старт

1. **Получите токены для Finedog API:**
   - Перейди на страницу переменных окружения: https://devplatform.tcsbank.ru/tenants/tma-sre/variables?search=finedog
   - Найди переменные `client_id` и `client_secret` для проекта

2. **Создай файл `.env` в корне репозитория:**
   ```bash
   cp .env.example .env
   ```
   Заполни файл `.env` учётными данными.

3. **Инициализация выполнится автоматически** при первом обращении к скиллу.

4. **Работай с API** через прямые запросы к Finedog API с использованием токена из `.env`.

**При ошибке 401 или пустом ответе API:**
```bash
./assets/finedog-auth.sh  # Обновить токен
./assets/update-openapi.sh  # Обновить спецификации
```
