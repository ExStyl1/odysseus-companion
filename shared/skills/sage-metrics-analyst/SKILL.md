---
name: "sage-metrics-analyst"
description: "Исследование метрик Sage, запросов PromQL/MageQL и подготовка или изменение алертов по запросу."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «refactor» → «safe-refactor», режим «refactor». Старое имя не является отдельной командой.
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


# Sage Metrics Analyst

Универсальный скилл для работы с **метриками** в Sage: анализ, создание алертов, валидация для **любых систем**.

## Важное различие

| | **Метрики** | **Логи** |
|---|------------|----------|
| **Что** | Числовые данные (CPU, latency, count) | Текстовые события (ошибки, запросы) |
| **Где** | Sage PQL/Prometheus | Sage Logs (группы/системы) |
| **Запрос** | `pql rate(metric[5m])` | `dp sage logs -g <group> -s <system>` |
| **Когда** | Алерты, тренды, перцентили | Дебаг, расследование инцидентов |

**Этот скилл — только для метрик!** Для логов используй другой workflow.

## Когда использовать

**Обязательно применяй этот скилл когда:**
- Пользователь просит "посмотри метрики", "создай алерт", "проверь метрику в Sage"
- Нужно написать PromQL/MageQL запрос для Sage
- Требуется создать YAML или JS алерт для Sage
- Нужно расследовать инцидент по метрикам
- Пользователь хочет настроить мониторинг сервиса
- Требуется валидировать метрику перед деплоем алерта

**Не используй этот скилл для:**
- Поиска по логам (для этого `dp sage logs -g <group> -s <system>`)
- Общих вопросов про Kubernetes или инфраструктуру

## Рабочий процесс

### Шаг 1: Понимание задачи

Сначала уточни контекст:

1. **Какая система/сервис?** — tenant, namespace, app (например, `guidewire`, `payments`, `auth-service`)
2. **Какая метрика?** — имя метрики или тип (например, `http_requests_total`, `cpu_usage`, `latency_p99`)
3. **Какая цель?** — исследовать, создать алерт, расследовать инцидент
4. **Есть ли инцидент?** — если да, запроси временной диапазон

**Примеры уточняющих вопросов:**
- "Какое имя метрики в Sage?"
- "В каком окружении искать (prod/dev/stage)?"
- "За какой период нужны данные?"
- "Какой тип алерта нужен (пороговый, аномалии, рост)?"
- "Какие лейблы есть у этой метрики?"

### Шаг 2: Анализ метрик

**2.1. Проверка доступности метрики**

Сначала убедись, что метрика существует в Sage:

```bash
# Поиск метрики по имени
dp sage query --query='pql <metric_name>' --hours=1
```

Если метрика не найдена — предложи альтернативы или проверь лейблы.

**2.2. Исследование лейблов**

Узнай доступные лейблы метрики:

```bash
# Получить уникальные значения лейблов
dp sage query --query='pql count by (<label_name>) (<metric_name>)' --hours=24
```

**Важно:** Лейблы могут отличаться от ожидаемых! Всегда проверяй актуальные лейблы через запрос к Sage.

Частые лейблы:
- `exported_env` / `env` — окружение
- `spirit_tenant` / `tenant` — tenant проекта
- `app` / `service` — имя сервиса
- `pod`, `container`, `namespace` — Kubernetes
- `method`, `path`, `status` — HTTP метрики
- `queue`, `topic` — очереди и топики

**2.3. Анализ данных за период**

Для понимания нормального поведения метрики:

```bash
# Среднее значение за неделю
dp sage query --query='pql avg_over_time(rate(<metric_name>[5m])[7d])'

# Максимум за период инцидента
dp sage query --query='pql max by (<labels>) (<metric_name>)' --from=<start> --to=<end>

# Текущее значение
dp sage query --query='pql <metric_name>{labels}' --hours=1
```

### Шаг 3: Создание запроса

**3.1. Выбор типа запроса**

| Тип | Когда использовать | Пример |
|-----|-------------------|--------|
| **rate()** | Для counter-метрик (рост за время) | `rate(metric[5m]) * 60` |
| **avg_over_time()** | Среднее за период | `avg_over_time(metric[1h])` |
| **max_over_time()** | Пиковые значения | `max_over_time(metric[1h])` |
| **increase()** | Прирост за период | `increase(metric[1h])` |
| **histogram_quantile()** | Перцентили latency | `histogram_quantile(0.99, rate(bucket[5m]))` |
| **min_over_time()** | Устойчивость значения | `min_over_time((metric > 10)[5m])` |
| **WITH** | Сложные вычисления | `WITH (baseline = ..., current = ...)` |

**3.2. Формирование запроса**

Пример для анализа аномалий:

```pql
pql step=30m
WITH (
  baseline = avg_over_time(rate(metric{labels}[5m])[7d]),
  current = rate(metric{labels}[5m]) * 60
)
(current > baseline * 3) and (current > 100)
| stats max(value) by app, id, status
```

**Важно:**
- `step` должен соответствовать периоду (30m для недельных данных)
- Sage не поддерживает `quantile_over_time`, используй `avg_over_time`
- Для `avg_over_time[7d]` синтаксис: `avg_over_time(expr[7d])` (без запятой)

**3.3. Специфичные типы метрик**

**Latency/Performance:**
```pql
# P99 latency из histogram
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{app="api"}[5m]))

# Средняя latency
rate(http_request_duration_seconds_sum{app="api"}[5m]) / rate(http_request_duration_seconds_count{app="api"}[5m])
```

**Error Rate:**
```pql
# Процент ошибок
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100
```

**Resource Usage:**
```pql
# CPU usage (из container_cpu_usage_seconds_total)
rate(container_cpu_usage_seconds_total{pod="api-xyz"}[5m]) * 100

# Memory usage percentage
container_memory_usage_bytes{pod="api-xyz"} / container_spec_memory_limit_bytes{pod="api-xyz"} * 100
```

**Queue/Backlog:**
```pql
# Размер очереди
kafka_consumer_group_lag{consumer_group="my-consumer"}

# Скорость обработки
rate(messages_processed_total{queue="orders"}[5m]) * 60
```

### Шаг 4: Создание алерта

**4.1. Выбор типа алерта**

| Тип | Формат | Когда использовать |
|-----|--------|-------------------|
| **YAML** | Декларативный | Простые пороги, стандартные алерты |
| **JS** | Программный | Сложная логика, кастомные условия |

**4.2. Структура YAML-алерта**

```yaml
labels:
  - name: <alerts-group-name>
    rules:
      - alert: "<AlertName>"
        expr: |
          pql step=30m
          WITH (...)
          <your-query>
          | stats max(value) as value by <labels>
        for: 15m          # Временное окно (избегай alert fatigue)
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "<Краткое описание>"
          description: "<Полное описание>"
          receivers:
            - name: slack:_CHANNEL_NAME_
          recovery_enabled: true
```

### 4.2. Параметры алерта

| Параметр | Рекомендация | Обоснование |
|----------|-------------|-------------|
| **step** | 5m для очередей, 15-30m для трендов | Меньший step = быстрее детектирование |
| **for** | 10-15m | Только устойчивые аномалии |
| **Мин. порог** | Зависит от метрики | Отсекает фоновый шум |
| **Мультипликатор** | 2-3× от baseline | Значимые отклонений |
| **baseline** | 7 дней | Адаптация к поведению системы |
| **Устойчивость** | `min_over_time` + `for` | Двойная защита от ложных |

**Критичные алерты (очереди, ошибки):**
- `step=5m` — быстрое обнаружение
- `for=10-15m` — устойчивость
- `min_over_time((condition > threshold)[5m]) >= 1` — все 5 минут превышен порог

**Тренды (CPU, memory, latency):**
- `step=15-30m` — сглаживание пиков
- `for=15-30m` — долгосрочные аномалии
- `avg_over_time(metric[7d])` — baseline за неделю

**4.3. Типы алертов**

**Пороговый (Threshold):**
```yaml
expr: pql cpu_usage > 80
for: 10m
```

**Аномалия (Anomaly Detection):**
```yaml
expr: |
  pql step=30m
  WITH (baseline = avg_over_time(metric[7d]), current = metric)
  current > baseline * 3
for: 15m
```

**Рост (Rate of Change):**
```yaml
expr: |
  pql step=5m
  rate(error_total[5m]) > 100
for: 5m
```

**Процент ошибок (Error Budget):**
```yaml
expr: |
  pql step=1m
  (rate(errors[5m]) / rate(total[5m])) * 100 > 1
for: 10m
```

**Отсутствие обработки (Processing Stopped):**
```yaml
expr: |
  pql step=5m
  WITH (
    commonFilter = {spirit_tenant="guidewire", app="bc"},
    current = rate(guidewire_message_transport_total{commonFilter}[5m])
  )
  # rate = 0 в течение 60 минут (12 интервалов по 5м)
  sum_over_time((current == 0)[60m]) >= 12
  | stats count() as cnt by app, id, status
for: 1h
```

**Когда использовать:** Обработчики очередей, фоновые джобы, воркеры.
**Ловит:** Полную остановку обработки (rate = 0).
**Не ловит:** Замедление обработки (rate снижается, но > 0).

**4.5. Консервативная настройка (избегаем alert fatigue)**

Каждый алерт обязателен к разбирательству. Настрой пороги так:
- **Минимальный порог** — отсекает фоновые значения
- **Мультипликатор** — 2-3× от baseline для значимых отклонений
- **Временное окно** — 10-15m для устойчивых аномалий
- **Устойчивость** — `sum_over_time((condition)[N*m]) >= K` для длительных инцидентов

**Пример из production:**
Алерт `MessageTransportProcessingStopped` (очереди Guidewire):
- Было: `sum_over_time((current == 0)[15m]) >= 3` → ~326 срабатываний/неделю
- Стало: `sum_over_time((current == 0)[60m]) >= 12` → ~1-3 срабатывания/месяц

### Шаг 5: Валидация

**5.1. Тестирование запроса**

Проверь запрос на исторических данных:

```bash
# Детектирует ли инцидент?
dp sage query --query='<your-query>' --from=<incident-start> --to=<incident-end>
```

**5.2. Проверка на ложные срабатывания**

```bash
# Сколько срабатываний за неделю в норме?
dp sage query --query='<your-query>' --hours=168
```

Если много срабатываний без инцидентов — повысь пороги или увеличь устойчивость.

**Пример из production:**
```bash
# Проверка за 3 месяца (90 дней)
# Раздели на 13 недель по 7 дней для обхода ограничения Sage (30 дней хранения)
for week in {1..13}; do
  dp sage query --query='<your-query>' --from=<start-week-$week> --to=<end-week-$week>
done
```

**Результат проверки:**
- Неделя 1 (03-10 февраля): ~326 срабатываний ❌ (слишком чувствительно)
- Остальные недели: 0 срабатываний ✅
- **Решение:** Увеличить устойчивость с 15м до 60м

**5.3. Preview-режим (опционально)**

```bash
# Логирование без деплоя
npm run deploy -- --preview
```

### Шаг 6: Деплой

**6.1. Локальный деплой**

```bash
# Создать файл с токеном
echo "APITOKEN=<your-token>" > devconfig.env

# Загрузить переменные
set -a && . ./devconfig.env

# Задеплоить
npm run deploy
```

**6.2. GitLab CI/CD**

1. Создать MR в ветку `master`
2. Дождаться прохождения pipeline
3. Замёржить MR (тестовые алерты удалятся автоматически)

**Важно:** Деплой новых триггеров удаляет существующие триггеры группы. Восстановление невозможно.

## Справочник

### Типы метрик и подходы

| Тип метрики | Примеры | Подход |
|-------------|---------|--------|
| **Counter** | `requests_total`, `errors_total` | `rate()[5m] * 60` |
| **Gauge** | `cpu_usage`, `memory_bytes` | Прямое значение или `avg_over_time()` |
| **Histogram** | `request_duration_seconds_bucket` | `histogram_quantile(0.99, ...)` |
| **Summary** | `request_duration_seconds{quantile="0.99"}` | Прямое использование |

### Частые паттерны алертов

**1. High CPU/Memory:**
```pql
container_cpu_usage_seconds_total{pod="api"} > 0.8
container_memory_usage_bytes{pod="api"} / container_spec_memory_limit_bytes{pod="api"} > 0.85
```

**2. High Error Rate:**
```pql
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100 > 5
```

**3. High Latency:**
```pql
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 1
```

**4. Queue Backlog:**
```pql
kafka_consumer_group_lag{consumer_group="orders"} > 10000
```

**5. Pod Restarts:**
```pql
increase(kube_pod_container_status_restarts_total{pod="api"}[1h]) > 3
```

**6. Database Connections:**
```pql
pg_stat_activity_count{datname="mydb"} > 80
```

**7. Queue Processing Stopped (отсутствие обработки):**
```pql
pql step=5m
WITH (
  commonFilter = {spirit_tenant="guidewire", app="bc"},
  current = rate(guidewire_message_transport_total{commonFilter}[5m])
)
# rate = 0 в течение 60 минут (12 интервалов по 5м)
sum_over_time((current == 0)[60m]) >= 12
| stats count() as cnt by app, id, status
```

**Когда использовать:** Обработчики очередей, фоновые джобы, воркеры.
**Ловит:** Полную остановку обработки (rate = 0).
**Не ловит:** Замедление обработки (rate снижается, но > 0).

**Пример из production:**
- **Инцидент 24-25 марта:** Очередь BC достигла 91 316 сообщений, rate = 3404 сообщ./мин
- **Инцидент 6 апреля:** Обработчик BC остановился в 3:00, rate = 0, длительность 1ч 13м
- **Алерт с устойчивостью 15м:** ~326 срабатываний/неделю (ложные)
- **Алерт с устойчивостью 60м:** ~1-3 срабатывания/месяц (реальные инциденты)

### Ссылки

- [Sage API Auth](https://sage.tcsbank.ru/documentation/api_auth)
- [Sage Documentation](https://sage.tcsbank.ru/documentation)
- [Grafana](https://sage.tcsbank.ru/grafana)
- [PromQL Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)

## Продвинутые паттерны (из production-алертов)

### 1. Временные фильтры (Time-based Alerting)

**Только в рабочее время:**
```pql
and ON() hour() >= 9 and hour() < 18
```

**Только ночью (вне рабочего времени):**
```pql
and on() ((hour() >= 20) or (hour() < 8))
```

**Пример:** Алерт на падение трафика, важный только когда ожидается активность:
```yaml
expr: |
  pql step=5m
  rate(http_requests_total[5m]) < 10
  and ON() hour() >= 9 and hour() < 18
for: 15m
```

### 2. Cooldown для группировки инцидентов

**Проблема:** Одинаковые алерты спамят канал при массовом инциденте.

**Решение:**
```yaml
annotations:
  cooldown_key: "{{ alert.id }} - {{hashFrom query.result 'AlertId'}}"
  cooldown_duration: 1200  # 20 минут
```

**Как работает:** Алерты с одинаковым `cooldown_key` не срабатывают чаще `cooldown_duration`.

### 3. Устойчивость через `min_over_time`

Вместо (или вместе с) `for`:

```pql
min_over_time(
  (rate(error_total[5m]) > 10)[5m]
) >= 1  # Все 5 минут превышен порог
```

### 4. Именованные фильтры (DRY)

**Паттерн для переиспользования фильтров:**

```pql
pql step=5m
with (
  commonFilters = {
    group="my-service-prod",
    service="api",
    env="prod"
  }
)
round(
  100 * (
    sum(rate(errors_total{commonFilters}[5m])) /
    sum(rate(requests_total{commonFilters}[5m]))
  )
) > 5
```

### 5. Защита от ложных на малых выборках

**Проблема:** При малом трафике даже 1 ошибка даёт 100% error rate.

**Решение — двойное условие:**
```pql
# Процент ошибок > 20%
(rate(errors[5m]) / rate(total[5m]) * 100) > 20
# И абсолютное число ошибок > 10
and increase(errors[5m]) > 10
```

**Или минимальный объём трафика:**
```pql
rate(requests_total[5m]) > 100  # Минимум 100 запросов в минуту
and (rate(errors[5m]) / rate(requests_total[5m])) > 0.05
```

### 6. Многоуровневое алертирование (Multi-level)

**Warning + Critical:**

```yaml
# Warning: 20% ошибок
- alert: High Error Rate (Warning)
  expr: pql error_rate > 20
  for: 15m
  
# Critical: 50% ошибок
- alert: High Error Rate (Critical)
  expr: pql error_rate > 50
  for: 5m
```

**Или каскад по времени:**
```yaml
# Раннее предупреждение
- alert: Error Rate Increasing
  expr: pql error_rate > 10
  for: 30m
  
# Эскалация
- alert: High Error Rate
  expr: pql error_rate > 25
  for: 10m
```

### 7. Шаблонизация описания алерта

**Используй Handlebars для динамического контента:**

```yaml
description: |
  :warning: Сработал алерт {{alert.name}}
  
  :chart_with_upwards_trend: Значение: {{query.result.value}}
  
  :server: Instance: ```{{query.result.instance}}```
  :package: Namespace: ```{{query.result.group}}```
  
  [Grafana]({{grafana_url}})
  [Runbook]({{runbook_url}})
```

### 8. Типичные ошибки и как избежать

| Ошибка | Проблема | Исправление |
|--------|----------|-------------|
| `step=1h` для очередей | Пропуск инцидентов | `step=5m` или `15m` |
| `for: 60m` | Позднее обнаружение | `10-15m` для критичных |
| `hour() >= 6 < 18` | Логическая ошибка | `hour() >= 6 and hour() < 18` |
| Нет мин. порога | Ложные на малых данных | `and increase(metric[5m]) > 10` |
| Сложные формулы | Трудно дебажить | Выносить в `WITH (...)` |
| `sum_over_time` с `stats` | Синтаксическая ошибка | Использовать `sum_over_time((condition)[Nm]) >= K` без `stats` |
| Нет проверки на исторических данных | Alert fatigue | Проверять за 2-4 недели перед деплоем |

## Выходной формат

Всегда предоставляй результат в этом порядке:

1. **План** — краткое описание шагов
2. **Запрос** — готовый PromQL/MageQL запрос
3. **Результаты** — вывод запроса с интерпретацией
4. **YAML-алерт** (если требуется) — готовая конфигурация
5. **Рекомендации** — следующие шаги

---

## Работа с графиками (Chart & Timechart)

### Chart Command

Для графиков с числовой осью X или группировкой по полям:

```bash
chart <stats-func>(<field>) over <field> [by <fields>]
```

**Примеры:**
```pql
# Распределение логов по inst
chart count over inst

# Распределение по статусам с группировкой
chart count over status by dc

# Статистика по числовому полю
chart max(counter), min(counter) over system
```

### Timechart Command

Для временных рядов:

```bash
timechart [span=<time>] [legend=json|custom] <stats-func>(<field>) [by <fields>]
```

**Параметры:**
- `span` — интервал агрегации (1m, 5m, 1h, 1d)
- `legend` — формат легенды (JSON или кастомный)

**Примеры:**
```pql
# Временной ряд количества логов
timechart count

# С шагом 5 минут и группировкой
timechart span=5m count by inst

# С JSON легендой
timechart span=1h legend=json count by env, system

# С кастомной легендой
timechart span=5m legend="\{{env}}-\{{system}}" count by env, system

# Несколько функций
timechart max(user.age) as oldest, min(user.age) as youngest by dc
```

### Ограничения

- **100K строк** после агрегации для chart/timechart
- **700K точек** для PQL запросов с chart/timechart
- При превышении — ошибка `MageRowsFetchedLimit`

---

## Типы алертов в Sage

### 1. YAML Git (простые)

**Структура:**
```yaml
labels:
  - name: <group-name>
    rules:
      - alert: "<AlertName>"
        expr: |
          pql step=5m
          <your-query>
        for: 15m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "<Описание>"
          receivers:
            - name: slack:_CHANNEL_
          recovery_enabled: true
```

**Преимущества:**
- Декларативный формат
- Версионирование в Git
- Простота поддержки

### 2. JavaScript (сложная логика)

**Функции:**
- `mage({start, end, query})` — выполнение MageQL запроса
- `sendAlert({address, message, cooldownKey, ...})` — отправка алерта
- `groupConfig()` — конфигурация группы

**Когда использовать:**
- Динамические пороги
- Сложная агрегация результатов
- Интеграция с внешними системами

### 3. MageQL (UI)

- Создание через UI Sage
- Визуальный редактор запросов
- Интеграция с Grafana

### 4. Anomaly (ML)

- Машинное обучение для детектирования аномалий
- Автоматический baseline
- Адаптивные пороги

---

## Troubleshooting алертов

### Коды ошибок

| Код | Причина | Решение |
|-----|---------|---------|
| **CodeIssues** | Ошибки валидации YAML | Проверить синтаксис, отступы |
| **BrokenExecution** | Ошибка выполнения JS | Проверить логи, обработать исключения |
| **HighCpuUsage** | Превышение CPU лимита | Оптимизировать запрос, уменьшить частоту |
| **MageRequestLimit** | >7 запросов к Sage | Кэшировать результаты, объединить запросы |
| **MageRowsFetchedLimit** | >1000 точек в ответе | Уменьшить период, добавить фильтрацию |
| **ConfigError** | Ошибка конфигурации | Проверить YAML структуру |
| **TimeoutError** | Превышение таймаута | Упростить запрос, уменьшить период |
| **AuthError** | Ошибка авторизации | Проверить токены, права доступа |
| **MetricNotFound** | Метрика не существует | Проверить имя метрики, лейблы |
| **QuerySyntaxError** | Ошибка в MageQL/PQL | Проверить синтаксис запроса |
| **DeliveryFailed** | Не доставлено в канал | Проверить настройки receivers |

### Диагностика

**Логи выполнения:**
```bash
# Просмотр логов алерта
dp sage logs -g <group> -s <system> -p "ошибки выполнения"
```

**Тестирование запроса:**
```bash
# Проверка на исторических данных
dp sage query --query='<your-query>' --from=<start> --to=<end>
```

---

## Продвинутые возможности MageQL

### Поиск по лейблам

**labels()** — получить все лейблы метрики:
```pql
labels(http_requests_total)
```

**label_values()** — значения конкретного лейбла:
```pql
label_values(http_requests_total, app)
```

### Instant Query

Мгновенное значение без временного ряда:
```pql
pql instant
http_requests_total{app="api"}
```

### Time Shift

Сравнение с периодом назад:

```pql
# Сдвиг на 1 неделю
pql step=5m
rate(http_requests_total[5m]) 
offset 7d
```

**date_add()** — арифметика дат:
```pql
date_add(now(), -7d)
```

### Join

Объединение результатов:
```pql
# Left join по лейблам
pql step=5m
join (left, right) on (app, env)
```

### Regex и Wildcards

**Regex match:**
```pql
status=~"5.."  # 500-599
app=~".*-api$"  # заканчивается на -api
```

**Negative regex:**
```pql
status!~"2.."  # не 2xx
```

**Wildcard:**
```pql
app="payments-*"  # payments-api, payments-service
```

### Группировка (Grouping)

**stats** — агрегация:
```pql
| stats count by app, status
| stats max(value) as max_val by env
```

**grouping** — группировка без агрегации:
```pql
| grouping (app, env)
```

---

## ErrorHub алерты

**ErrorHub** — централизованная система управления ошибками.

**Структура алерта:**
```yaml
error:
  code: "<ERROR_CODE>"
  message: "<Описание>"
  context:
    service: "<service-name>"
    metric: "<metric-name>"
```

**Преимущества:**
- Стандартизация кодов ошибок
- Централизованный каталог
- Интеграция с инцидентами
