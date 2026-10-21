# Руководство по использованию Sage Metrics Analyst

Подробное руководство с пошаговыми примерами для работы с метриками и создания алертов в Sage.

## Содержание

1. [Установка](#установка)
2. [Первые шаги](#первые-шаги)
3. [Анализ метрик](#анализ-метрик)
4. [Создание алертов](#создание-алертов)
5. [Продвинутые паттерны](#продвинутые-паттерны)
6. [Валидация и деплой](#валидация-и-деплей)
7. [Частые ошибки](#частые-ошибки)

---

## Установка

### Через Nessy CLI

```bash
npx @nessy/cli install ssh://git@gitlab.tcsbank.ru:7999/ins-sre/sage-metrics-analyst.git
```

### Проверка установки

После установки скилл будет автоматически активироваться при запросах о метриках и алертах.

**Триггер-фразы:**
- "посмотри метрики..."
- "создай алерт..."
- "проверь метрику в Sage"
- "почему растёт latency"
- "проанализируй инцидент по метрикам"

---

## Первые шаги

### Шаг 1: Проверка доступности метрики

Прежде чем создавать алерт, убедись, что метрика существует в Sage.

**Запрос:**
```
Проверь метрику http_requests_total в Sage
```

**Что сделает скилл:**
```bash
dp sage query --query='pql http_requests_total' --hours=1
```

**Интерпретация результата:**
- ✅ Метрика найдена → переходим к исследованию лейблов
- ❌ Метрика не найдена → проверяем имя или ищем альтернативы

### Шаг 2: Исследование лейблов

Узнай, какие лейблы доступны для фильтрации.

**Запрос:**
```
Какие лейблы есть у метрики http_requests_total?
```

**Что сделает скилл:**
```bash
dp sage query --query='pql count by (app, method, path, status, env) (http_requests_total)' --hours=24
```

**Частые лейблы:**
| Лейбл | Описание | Пример |
|-------|----------|--------|
| `app` / `service` | Имя сервиса | `payments-api`, `auth-service` |
| `env` / `exported_env` | Окружение | `prod`, `dev`, `stage` |
| `spirit_tenant` / `tenant` | Tenant проекта | `tibp`, `payments` |
| `pod`, `container` | Kubernetes | `api-xyz-7d8f9c` |
| `method`, `path` | HTTP | `GET`, `/api/v1/orders` |
| `status` | HTTP статус | `200`, `500`, `503` |
| `queue`, `topic` | Очереди | `orders-queue`, `notifications` |

### Шаг 3: Анализ нормального поведения

Пойми, какие значения метрики нормальны для твоей системы.

**Запрос:**
```
Покажи нормальные значения CPU для payments-api за неделю
```

**Что сделает скилл:**
```bash
dp sage query --query='pql avg_over_time(rate(container_cpu_usage_seconds_total{app="payments-api"}[5m])[7d])' --hours=168
```

**Результат:**
- Среднее: 25%
- Пики: до 60%
- Ночью: 10-15%

---

## Визуализация данных (Chart & Timechart)

### Chart Command

Для графиков с числовой осью X или группировкой по полям:

**Запрос:**
```
Покажи распределение HTTP ошибок по статусам и сервисам
```

**Что сделает скилл:**
```pql
chart count over status by dc
```

**Когда использовать:**
- Распределение по категориям (статусы, сервисы, лейблы)
- Гистограммы и бар-чарты
- Числовая ось X (не время)

### Timechart Command

Для временных рядов:

**Запрос:**
```
Покажи график ошибок по минутам за последние 6 часов
```

**Что сделает скилл:**
```pql
timechart span=5m count by status
```

**Параметры:**
- `span` — интервал агрегации: `1m`, `5m`, `1h`, `1d`
- `legend` — формат легенды:
  - `json` — JSON формат для автоматической обработки
  - `"\{{env}}-\{{system}}"` — кастомный формат

**Примеры:**
```pql
# Временной ряд количества логов
timechart count

# Временной ряд с шагом 5 минут
timechart span=5m count by inst

# С JSON легендой для автоматизации
timechart span=1h legend=json count by env, system

# С кастомной легендой
timechart span=5m legend="\{{env}}-\{{system}}" count by env, system

# Несколько функций
timechart max(user.age) as oldest, min(user.age) as youngest by dc
```

### Ограничения визуализации

| Параметр | Лимит |
|----------|-------|
| Строк после агрегации | 100K |
| Точек для PQL с chart/timechart | 700K |
| При превышении | Ошибка `MageRowsFetchedLimit` |

---

## Продвинутые возможности MageQL

### Поиск по лейблам

**labels()** — получить все лейблы метрики:

**Запрос:**
```
Какие лейблы есть у метрики http_requests_total?
```

**Результат:**
```pql
labels(http_requests_total)
```

**label_values()** — значения конкретного лейбла:

**Запрос:**
```
Какие значения лейбла app есть у метрики http_requests_total?
```

**Результат:**
```pql
label_values(http_requests_total, app)
```

### Instant Query

Мгновенное значение метрики (без временного ряда):

**Запрос:**
```
Текущее значение CPU для payments-api
```

**Результат:**
```pql
pql container_cpu_usage_seconds_total{app="payments-api"}
```

**Примечание:** Для instant query используй обычный PQL запрос без временных функций.

### Time Shift

Сравнение с периодом назад:

**Запрос:**
```
Сравни текущий трафик с прошлой неделей
```

**Результат:**
```pql
pql step=5m
rate(http_requests_total[5m]) offset 7d
```

**date_add()** — арифметика дат:
```pql
date_add(now(), -7d)  # 7 дней назад
```

### Join

Объединение результатов по лейблам:

**Запрос:**
```
Объедини метрики CPU и memory по pod
```

**Результат:**
```pql
pql step=5m
join (cpu, mem) on (pod, namespace)
```

**Примечание:** Требуется предварительное определение `cpu` и `mem` через WITH clause.

### Regex и Wildcards

**Regex match:**
```pql
status=~"5.."      # 500-599
app=~".*-api$"     # заканчивается на -api
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

## Анализ метрик

### Сценарий 1: Расследование инцидента

**Контекст:** В 14:49 был спайк ошибок до 237 ошибок/мин (норма 5-30).

**Запрос:**
```
Проанализируй спайк ошибок Guidewire за сегодня
```

**План анализа:**

1. **Проверка метрики:**
   ```bash
   dp sage query --query='pql sum(rate(guidewire_message_transport_total{status=~"ERROR|RETRYABLE_ERROR"}[5m])) * 60' --hours=4
   ```

2. **Детализация по лейблам:**
   ```bash
   dp sage query --query='pql sum by (app, status) (rate(guidewire_message_transport_total[5m])) * 60' --from="2026-03-27T14:00:00Z" --to="2026-03-27T15:00:00Z"
   ```

3. **Сравнение с baseline:**
   ```bash
   dp sage query --query='pql avg_over_time(sum(rate(guidewire_message_transport_total{status=~"ERROR"}[5m])) * 60[7d])' --hours=168
   ```

**Интерпретация:**
- ✅ Норма: 5-30 ошибок/мин
- ⚠️ Спайк: 237 ошибок/мин в 14:49
- 🔍 Причина: Ошибки `RETRYABLE_ERROR` по конкретному tenant

### Сценарий 2: Анализ latency

**Контекст:** Пользователи жалуются на медленные запросы.

**Запрос:**
```
Почему растёт latency в auth-service за последние 2 часа?
```

**План анализа:**

1. **P99 latency:**
   ```bash
   dp sage query --query='pql histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{app="auth-service"}[5m]))' --hours=2
   ```

2. **P95 latency для сравнения:**
   ```bash
   dp sage query --query='pql histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{app="auth-service"}[5m]))' --hours=2
   ```

3. **Средняя latency:**
   ```bash
   dp sage query --query='pql rate(http_request_duration_seconds_sum{app="auth-service"}[5m]) / rate(http_request_duration_seconds_count{app="auth-service"}[5m])' --hours=2
   ```

4. **Детализация по endpoint'ам:**
   ```bash
   dp sage query --query='pql histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{app="auth-service"}[5m])) by (path)' --hours=2
   ```

**Интерпретация:**
- P99 > 1s → критично медленно
- P95 ~ 500ms → приемлемо
- Конкретный `/api/v1/login` → проблема с БД или внешним сервисом

### Сценарий 3: Анализ использования памяти

**Контекст:** Подозрение на утечку памяти в `order-processor`.

**Запрос:**
```
Подозреваю утечку памяти в pod'ах order-processor. Посмотри метрики за 3 дня
```

**План анализа:**

1. **Текущее использование:**
   ```bash
   dp sage query --query='pql container_memory_usage_bytes{app="order-processor"}' --hours=1
   ```

2. **Тренд за 3 дня:**
   ```bash
   dp sage query --query='pql avg_over_time(container_memory_usage_bytes{app="order-processor"}[1h])' --hours=72
   ```

3. **Сравнение с лимитом:**
   ```bash
   dp sage query --query='pql container_memory_usage_bytes{app="order-processor"} / container_spec_memory_limit_bytes{app="order-processor"} * 100' --hours=72
   ```

**Интерпретация:**
- ✅ Ровная линия → нет утечки
- 📈 Пилообразный график → рестарты, но нет утечки
- 📈 Постоянный рост → утечка памяти

---

## Типы алертов в Sage

### 1. YAML Git (простые)

**Когда использовать:** Простые пороги, версионирование в Git.

**Структура:**
```yaml
labels:
  - name: payments-alerts
    rules:
      - alert: "High CPU Usage"
        expr: |
          pql step=5m
          rate(container_cpu_usage_seconds_total{app="payments-api"}[5m]) * 100 > 80
        for: 10m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Высокое использование CPU"
          description: |
            :warning: CPU usage > 80%
            :chart_with_upwards_trend: Значение: {{query.result.value}}%
          receivers:
            - name: slack:_PAYMENTS_ALERTS_
          recovery_enabled: true
```

**Преимущества:**
- Декларативный формат
- Версионирование в Git
- Простота поддержки

### 2. JavaScript (сложная логика)

**Когда использовать:** Динамические пороги, сложная агрегация.

**Функции:**
- `mage({start, end, query})` — выполнение MageQL запроса
- `sendAlert({address, message, cooldownKey, ...})` — отправка алерта
- `groupConfig()` — конфигурация группы

**Пример:**
```javascript
async function check() {
  const result = await mage({
    start: 'now-1h',
    end: 'now',
    query: 'pql rate(errors_total[5m])'
  });
  
  if (result.value > 100) {
    await sendAlert({
      address: 'slack:_ALERTS_',
      message: `High error rate: ${result.value}`,
      cooldownKey: `error-${result.service}`
    });
  }
}
```

### 3. MageQL (UI)

**Когда использовать:** Визуальное создание, интеграция с Grafana.

- Создание через UI Sage
- Визуальный редактор запросов
- Интеграция с Grafana

### 4. Anomaly (ML)

**Когда использовать:** Адаптивные пороги, детектирование аномалий.

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

**Запрос:**
```
Проверь логи выполнения алерта payments-alerts
```

**Что сделает скилл:**
```bash
dp sage logs -g <group> -s <system> -p "ошибки выполнения"
```

**Тестирование запроса:**
```bash
# Проверка на исторических данных
dp sage query --query='<your-query>' --from=<start> --to=<end>
```

---

## Создание алертов

### Тип 1: Пороговый алерт (Threshold)

**Когда:** Знаешь нормальные значения и хочешь алерт при превышении.

**Пример:** CPU > 80%

**Запрос:**
```
Создай алерт на CPU usage для payments-api, порог 80%
```

**Результат (YAML):**
```yaml
labels:
  - name: payments-alerts
    rules:
      - alert: "High CPU Usage"
        expr: |
          pql step=5m
          rate(container_cpu_usage_seconds_total{app="payments-api"}[5m]) * 100 > 80
        for: 10m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Высокое использование CPU"
          description: |
            :warning: CPU usage > 80%
            
            :chart_with_upwards_trend: Значение: {{query.result.value}}%
            
            :server: Pod: ```{{query.result.pod}}```
            :package: App: ```{{query.result.app}}```
          receivers:
            - name: slack:_PAYMENTS_ALERTS_
          recovery_enabled: true
```

### Тип 2: Алерт на аномалии (Anomaly Detection)

**Когда:** Не знаешь точный порог, хочешь ловить отклонения от нормы.

**Пример:** Трафик отклоняется в 3 раза от baseline.

**Запрос:**
```
Создай алерт на аномалии трафика — отклонение от baseline в 3 раза
```

**Результат (YAML):**
```yaml
labels:
  - name: traffic-alerts
    rules:
      - alert: "Traffic Anomaly"
        expr: |
          pql step=30m
          WITH (
            baseline = avg_over_time(rate(http_requests_total[5m])[7d]),
            current = rate(http_requests_total[5m]) * 60
          )
          (current > baseline * 3) and (current > 100)
        for: 15m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Аномалия трафика"
          description: |
            :warning: Трафик отклоняется от baseline в 3+ раза
            
            :chart_with_upwards_trend: Текущий: {{query.result.current}}
            :bar_chart: Baseline: {{query.result.baseline}}
          receivers:
            - name: slack:_INFRA_ALERTS_
          recovery_enabled: true
```

### Тип 3: Процент ошибок (Error Rate)

**Когда:** Хочешь контролировать качество сервиса.

**Пример:** HTTP 5xx > 5%

**Запрос:**
```
Создай алерт на процент HTTP ошибок 5xx. Норма <1%, инциденты >5%
```

**Результат (YAML):**
```yaml
labels:
  - name: error-rate-alerts
    rules:
      - alert: "High HTTP Error Rate"
        expr: |
          pql step=5m
          WITH (
            error_rate = (
              sum(rate(http_requests_total{status=~"5.."}[5m])) /
              sum(rate(http_requests_total[5m]))
            ) * 100
          )
          error_rate > 5
        for: 10m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Высокий процент HTTP ошибок"
          description: |
            :warning: Error rate > 5%
            
            :chart_with_upwards_trend: Значение: {{query.result.error_rate}}%
          receivers:
            - name: slack:_ERRORS_ALERTS_
          recovery_enabled: true
```

### Тип 4: Multi-level алерт (Warning + Critical)

**Когда:** Хочешь раннее предупреждение и эскалацию.

**Запрос:**
```
Нужны Warning и Critical алерты на ошибки. Warning >20%, Critical >50%
```

**Результат (YAML):**
```yaml
labels:
  - name: error-rate-alerts
    rules:
      # Warning: раннее предупреждение
      - alert: "Error Rate Warning"
        expr: |
          pql step=5m
          (rate(errors_total[5m]) / rate(total[5m])) * 100 > 20
        for: 15m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Рост процента ошибок (Warning)"
          receivers:
            - name: slack:_TEAM_CHANNEL_
          recovery_enabled: true
      
      # Critical: эскалация
      - alert: "Error Rate Critical"
        expr: |
          pql step=5m
          (rate(errors_total[5m]) / rate(total[5m])) * 100 > 50
        for: 5m
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "Критический процент ошибок"
          receivers:
            - name: slack:_ONCALL_CHANNEL_
          recovery_enabled: true
```

---

## Продвинутые паттерны

### 1. Временные фильтры (Time-based)

**Проблема:** Алерты срабатывают ночью, когда трафика нет.

**Решение:** Фильтр по времени суток.

**Только рабочее время (9-18):**
```pql
pql step=5m
rate(http_requests_total[5m]) < 10
and ON() hour() >= 9 and hour() < 18
```

**Только ночью (20-08):**
```pql
pql step=5m
rate(http_requests_total[5m]) < 5
and on() ((hour() >= 20) or (hour() < 8))
```

### 2. Cooldown для группировки инцидентов

**Проблема:** Одинаковые алерты спамят канал при массовом инциденте.

**Решение:**
```yaml
annotations:
  cooldown_key: "{{ alert.id }} - {{hashFrom query.result 'AlertId'}}"
  cooldown_duration: 1200  # 20 минут
```

### 3. Устойчивость через min_over_time

**Проблема:** Кратковременные спайки вызывают ложные алерты.

**Решение:**
```pql
min_over_time(
  (rate(error_total[5m]) > 10)[5m]
) >= 1  # Все 5 минут превышен порог
```

### 4. Именованные фильтры (DRY)

**Проблема:** Одинаковые фильтры в множестве алертов.

**Решение:**
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

**Проблема:** При 1 запросе в минуту даже 1 ошибка = 100% error rate.

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

---

## Валидация и деплой

### Валидация запроса

**Шаг 1: Тестирование на исторических данных**

Проверь, детектирует ли запрос известный инцидент:

```bash
dp sage query --query='<your-query>' --from="2026-03-27T14:00:00Z" --to="2026-03-27T15:00:00Z"
```

**Шаг 2: Проверка на ложные срабатывания**

Проверь, сколько срабатываний было за неделю в норме:

```bash
dp sage query --query='<your-query>' --hours=168
```

Если много срабатываний без инцидентов → повысь пороги.

### Деплой через MR

**Шаг 1: Создание файла алерта**

Сохрани YAML в репозиторий алертов:
```
src/alerts/yaml/<group>-alerts.yml
```

**Шаг 2: Создание MR**

```bash
git add src/alerts/yaml/<group>-alerts.yml
git commit -m "feat: add <alert-name> alert for <service>"
git push -u origin <branch-name>
```

**Шаг 3: Merge и деплой**

1. Создать MR в `master`
2. Дождаться прохождения pipeline
3. Замёржить MR
4. Алерт задеплоится в тестовую группу автоматически

---

## Частые ошибки

| Ошибка | Проблема | Исправление |
|--------|----------|-------------|
| `step=1h` для очередей | Пропуск инцидентов | `step=5m` или `15m` |
| `for: 60m` | Позднее обнаружение | `10-15m` для критичных |
| `hour() >= 6 < 18` | Логическая ошибка | `hour() >= 6 and hour() < 18` |
| Нет мин. порога | Ложные на малых данных | `and increase(metric[5m]) > 10` |
| Сложные формулы | Трудно дебажить | Выносить в `WITH (...)` |
| `quantile_over_time` | Не поддерживается в Sage | Использовать `avg_over_time` |
| `avg_over_time[7d]` с запятой | Синтаксическая ошибка | `avg_over_time(expr[7d])` (без запятой) |

---

## Поддержка

Вопросы и предложения направляй в команду ins-sre.
