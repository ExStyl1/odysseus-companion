# Каталог продвинутых паттернов алертов

Сборник лучших практик создания алертов для Sage на основе анализа production-алертов ins-sre.

## Содержание

1. [Временные фильтры](#1-временные-фильтры)
2. [Cooldown для группировки](#2-cooldown-для-группировки)
3. [Устойчивость через min_over_time](#3-устойчивость-через-min_over_time)
4. [DRY с WITH clause](#4-dry-с-with-clause)
5. [Защита от малых выборок](#5-защита-от-малых-выборок)
6. [Multi-level алертирование](#6-multi-level-алертирование)
7. [Шаблонизация описания](#7-шаблонизация-описания)
8. [Типовые сценарии](#8-типовые-сценарии)

---

## 1. Временные фильтры

### 1.1. Алерты только в рабочее время

**Когда использовать:** Бизнес-метрики, важные только когда ожидается активность.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  rate(http_requests_total[5m]) < 10
  and ON() hour() >= 9 and hour() < 18
for: 15m
```

**Пример:** Алерт на падение трафика, срабатывает только 9-18 часов.

### 1.2. Алерты только ночью

**Когда использовать:** Фоновые процессы, ночные джобы.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  rate(batch_jobs_failed[5m]) > 5
  and on() ((hour() >= 20) or (hour() < 8))
for: 10m
```

**Пример:** Алерт на ошибки ночной обработки данных.

### 1.3. Выходные дни

**Когда использовать:** Метрики, актуальные только в будни.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  rate(api_requests[5m]) < 50
  and ON() day_of_week() >= 1 and day_of_week() <= 5
for: 30m
```

---

## 2. Cooldown для группировки

### 2.1. Базовый cooldown

**Проблема:** При массовом инциденте срабатывают десятки одинаковых алертов.

**Решение:**
```yaml
annotations:
  cooldown_key: "{{ alert.id }} - {{hashFrom query.result 'AlertId'}}"
  cooldown_duration: 1200  # 20 минут
```

**Как работает:**
- Алерты с одинаковым `cooldown_key` не срабатывают чаще `cooldown_duration`
- `hashFrom query.result` группирует алерты по результатам запроса

### 2.2. Cooldown по инстансу

**Когда:** Хочешь группировать алерты от одного источника.

**Паттерн:**
```yaml
annotations:
  cooldown_key: "{{ query.result.instance }}"
  cooldown_duration: 900  # 15 минут
```

### 2.3. Cooldown по типу ошибки

**Когда:** Группировка по типу проблемы.

**Паттерн:**
```yaml
annotations:
  cooldown_key: "{{ query.result.error_type }}"
  cooldown_duration: 1800  # 30 минут
```

---

## 3. Устойчивость через min_over_time

### 3.1. Базовый паттерн

**Проблема:** Кратковременные спайки вызывают ложные алерты.

**Решение:**
```yaml
expr: |
  pql step=5m
  min_over_time(
    (rate(error_total[5m]) > 10)[5m]
  ) >= 1
```

**Как работает:**
- `(rate(error_total[5m]) > 10)` → булево значение (1 или 0) каждые 5 минут
- `min_over_time(...[5m])` → минимум за 5 минут
- `>= 1` → все 5 минут было превышение

### 3.2. Комбинация с for

**Когда:** Хочешь двойную защиту от ложных.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  min_over_time(
    (rate(error_total[5m]) > 10)[3m]
  ) >= 1
for: 5m  # Дополнительно ждём 5 минут
```

### 3.3. Для gauge-метрик

**Когда:** Метрика должна быть стабильно высокой.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  min_over_time(
    (cpu_usage > 80)[10m]
  ) >= 1
```

---

## 4. DRY с WITH clause

### 4.1. Базовый паттерн

**Проблема:** Одинаковые фильтры в множестве мест.

**Решение:**
```yaml
expr: |
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

### 4.2. Несколько общих фильтров

**Когда:** Несколько наборов фильтров.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  with (
    prodFilters = {env="prod", tier="frontend"},
    errorFilter = {status=~"5.."},
    
    prodErrors = sum(rate(errors_total{prodFilters, errorFilter}[5m])),
    prodTotal = sum(rate(requests_total{prodFilters}[5m]))
  )
  (prodErrors / prodTotal) * 100 > 5
```

### 4.3. Сложные вычисления

**Когда:** Многоуровневые расчёты.

**Паттерн:**
```yaml
expr: |
  pql step=30m
  WITH (
    # Baseline за 7 дней
    baseline = avg_over_time(rate(http_requests_total[5m])[7d]),
    
    # Текущее значение
    current = rate(http_requests_total[5m]) * 60,
    
    # Отклонение
    deviation = current / baseline
  )
  (deviation > 3) and (current > 100)
```

---

## 5. Защита от малых выборок

### 5.1. Двойное условие (процент + абсолютное число)

**Проблема:** При 1 запросе в минуту даже 1 ошибка = 100% error rate.

**Решение:**
```yaml
expr: |
  pql step=5m
  # Процент ошибок > 20%
  (rate(errors[5m]) / rate(total[5m]) * 100) > 20
  # И абсолютное число ошибок > 10
  and increase(errors[5m]) > 10
```

### 5.2. Минимальный объём трафика

**Когда:** Алерт имеет смысл только при достаточном трафике.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  # Минимум 100 запросов в минуту
  rate(requests_total[5m]) > 100
  # И процент ошибок > 5%
  and (rate(errors[5m]) / rate(requests_total[5m])) > 0.05
```

### 5.3. Минимальное количество подов

**Когда:** Алерт на поды имеет смысл, когда их больше N.

**Паттерн:**
```yaml
expr: |
  pql step=5m
  count(kube_pod_status_phase{phase="Running"}) > 3
  and
  sum(rate(container_cpu_usage_seconds_total[5m])) / count(kube_pod_status_phase{phase="Running"}) > 80
```

---

## 6. Multi-level алертирование

### 6.1. Warning + Critical (каскад по порогу)

**Когда:** Раннее предупреждение + эскалация.

**Паттерн:**
```yaml
labels:
  - name: error-alerts
    rules:
      # Warning: 20% ошибок
      - alert: "Error Rate Warning"
        expr: |
          pql step=5m
          error_rate > 20
        for: 15m
        annotations:
          summary: "Рост процента ошибок (Warning)"
          receivers:
            - name: slack:_TEAM_CHANNEL_
        recovery_enabled: true
      
      # Critical: 50% ошибок
      - alert: "Error Rate Critical"
        expr: |
          pql step=5m
          error_rate > 50
        for: 5m
        annotations:
          summary: "Критический процент ошибок"
          receivers:
            - name: slack:_ONCALL_CHANNEL_
        recovery_enabled: true
```

### 6.2. Каскад по времени

**Когда:** Сначала предупреждение, потом эскалация если не исправлено.

**Паттерн:**
```yaml
labels:
  - name: memory-alerts
    rules:
      # Раннее предупреждение
      - alert: "Memory Usage Increasing"
        expr: |
          pql step=5m
          memory_usage > 70
        for: 30m
        annotations:
          summary: "Использование памяти растёт"
          receivers:
            - name: slack:_TEAM_CHANNEL_
        recovery_enabled: true
      
      # Эскалация
      - alert: "High Memory Usage"
        expr: |
          pql step=5m
          memory_usage > 85
        for: 10m
        annotations:
          summary: "Высокое использование памяти"
          receivers:
            - name: slack:_ONCALL_CHANNEL_
        recovery_enabled: true
```

### 6.3. Three-level (Info + Warning + Critical)

**Когда:** Полная градация серьёзности.

**Паттерн:**
```yaml
labels:
  - name: latency-alerts
    rules:
      # Info: для мониторинга
      - alert: "Latency Increased"
        expr: pql p99_latency > 0.5
        for: 15m
        annotations:
          summary: "Latency выше нормы"
          receivers:
            - name: slack:_MONITORING_CHANNEL_
        recovery_enabled: true
      
      # Warning: требует внимания
      - alert: "High Latency"
        expr: pql p99_latency > 1.0
        for: 10m
        annotations:
          summary: "Высокая latency"
          receivers:
            - name: slack:_TEAM_CHANNEL_
        recovery_enabled: true
      
      # Critical: требует немедленного действия
      - alert: "Critical Latency"
        expr: pql p99_latency > 2.0
        for: 5m
        annotations:
          summary: "Критическая latency"
          receivers:
            - name: slack:_ONCALL_CHANNEL_
        recovery_enabled: true
```

---

## 7. Шаблонизация описания

### 7.1. Базовый шаблон

**Паттерн:**
```yaml
annotations:
  summary: "Высокий уровень ошибок {{query.result.service}}"
  description: |
    :warning: Сработал алерт {{alert.name}}
    
    :chart_with_upwards_trend: Значение: {{query.result.value}}
    
    :server: Instance: ```{{query.result.instance}}```
    :package: Namespace: ```{{query.result.group}}```
    :inbox: App: ```{{query.result.app}}```
    
    Проверьте логи и статус сервиса.
  receivers:
    - name: slack:_ALERTS_CHANNEL_
  recovery_enabled: true
  grafana_url: "https://sage.tcsbank.ru/grafana"
```

### 7.2. С ссылкой на runbook

**Паттерн:**
```yaml
annotations:
  description: |
    :warning: Сработал алерт {{alert.name}}
    
    :chart_with_upwards_trend: Значение: {{query.result.value}}
    
    :book: [Runbook](https://wiki.tcsbank.ru/runbooks/{{alert.name}})
    :chart_with_upwards_trend: [Grafana]({{grafana_url}})
  runbook_url: "https://wiki.tcsbank.ru/runbooks/{{alert.name}}"
```

### 7.3. С динамическими ссылками

**Паттерн:**
```yaml
annotations:
  description: |
    :warning: {{alert.name}}
    
    :server: Pod: ```{{query.result.pod}}```
    :package: App: ```{{query.result.app}}```
    
    [Логи Sage](https://sage.tcsbank.ru/logs?pod={{query.result.pod}})
    [Метрики Grafana](https://sage.tcsbank.ru/grafana/d/{{dashboard_id}}?var-pod={{query.result.pod}})
```

---

## 8. Типовые сценарии

### 8.1. CPU Usage

```yaml
- alert: "High CPU Usage"
  expr: |
    pql step=5m
    rate(container_cpu_usage_seconds_total{app="api"}[5m]) * 100 > 80
  for: 10m
```

### 8.2. Memory Usage

```yaml
- alert: "High Memory Usage"
  expr: |
    pql step=5m
    container_memory_usage_bytes{app="api"} / container_spec_memory_limit_bytes{app="api"} * 100 > 85
  for: 15m
```

### 8.3. P99 Latency

```yaml
- alert: "High P99 Latency"
  expr: |
    pql step=5m
    histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{app="api"}[5m])) > 1.0
  for: 10m
```

### 8.4. Error Rate

```yaml
- alert: "High Error Rate"
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
```

### 8.5. Queue Backlog

```yaml
- alert: "Kafka Lag High"
  expr: |
    pql step=5m
    kafka_consumer_group_lag{consumer_group="orders"} > 10000
  for: 15m
```

### 8.6. Pod Restarts

```yaml
- alert: "Pod Restarts"
  expr: |
    pql step=5m
    increase(kube_pod_container_status_restarts_total{pod="api"}[1h]) > 3
  for: 5m
```

### 8.7. Database Connections

```yaml
- alert: "DB Connections High"
  expr: |
    pql step=5m
    pg_stat_activity_count{datname="mydb"} / pg_settings_max_connections{datname="mydb"} * 100 > 80
  for: 10m
```

### 8.8. Guidewire Errors (пример из production)

```yaml
- alert: "Guidewire High Error Rate"
  expr: |
    pql step=5m
    WITH (
      error_rate = sum(rate(guidewire_message_transport_total{status=~"ERROR|RETRYABLE_ERROR"}[5m])) * 60
    )
    error_rate > 50
  for: 10m
  annotations:
    summary: "Высокий уровень ошибок Guidewire Message Transport"
    description: |
      :warning: Сработал алерт {{alert.name}}

      :chart_with_upwards_trend: Ошибок в минуту: {{query.result.value}}

      :server: Instance: ```{{query.result.instance}}```
      :package: Tenant: ```{{query.result.spirit_tenant}}```
      :inbox: App: ```{{query.result.app}}```

      Проверьте логи guidewire-exporter и статус очередей.
```

### 8.9. Time Shift (сравнение с периодом)

```yaml
- alert: "Traffic Drop vs Last Week"
  expr: |
    pql step=5m
    WITH (
      current = rate(http_requests_total[5m]) * 60,
      last_week = rate(http_requests_total[5m] offset 7d) * 60
    )
    current < last_week * 0.5
  for: 15m
```

### 8.10. Label Search (динамические лейблы)

```yaml
- alert: "New Service High Errors"
  expr: |
    pql step=5m
    label_values(http_requests_total, app)
    | stats sum(rate(errors_total{app=~".*"}[5m])) by app
    > 100
  for: 10m
```

### 8.11. Processing Stopped (отсутствие обработки)

**Когда использовать:** Обработчики очередей, фоновые процессы, воркеры.

**Паттерн:**
```yaml
- alert: "MessageTransportProcessingStopped"
  expr: |
    pql step=5m
    WITH (
      commonFilter = {
        spirit_tenant="guidewire",
        app="bc",
        status=~"PENDING_SEND|ERROR|RETRYABLE_ERROR"
      },
      current = rate(guidewire_message_transport_total{commonFilter}[5m])
    )
    # rate = 0 в течение 60 минут (12 интервалов по 5м)
    sum_over_time((current == 0)[60m]) >= 12
    | stats count() as cnt by app, id, status
  for: 1h
  annotations:
    summary: "⛔ Обработчик очередей остановлен"
    description: |
      :no_entry: Обработчик очередей **НЕ РАБОТАЕТ**!

      {{#each query.result}}
      **Приложение:** {{app}}, **Очередь:** {{id}}, **Статус:** {{status}}
      **Длительность простоя:** {{cnt}} интервалов ({{calc cnt "* 5"}} минут)
      {{/each}}

      Это может означать:
      - Обработчик остановлен после деплоя
      - Ошибка в коде обработчика
      - Проблемы с подключением к очереди
```

**Преимущества:**
- ✅ Ловит полную остановку обработки (rate = 0)
- ✅ Ловит инциденты типа "обработчик не запустился после релиза"
- ✅ Устойчивость к кратковременным остановкам (60 минут)

**Ограничения:**
- ❌ Не ловит замедление обработки (rate снижается, но > 0)
- ❌ Не ловит рост очереди (rate > 0, но counter растёт медленно)

**История из production:**
- **Инцидент 24-25 марта:** Очередь BC достигла 91 316 сообщений, rate = 3404 сообщ./мин
- **Инцидент 6 апреля:** Обработчик BC остановился в 3:00, rate = 0, длительность 1ч 13м
- **Алерт с устойчивостью 15м:** ~326 срабатываний/неделю (ложные)
- **Алерт с устойчивостью 60м:** ~1-3 срабатывания/месяц (реальные инциденты)

---

## ErrorHub алерты

**ErrorHub** — централизованная система управления ошибками.

**Структура:**
```yaml
error:
  code: "HIGH_ERROR_RATE"
  message: "Превышен порог процента ошибок"
  context:
    service: "payments-api"
    metric: "http_requests_total"
    threshold: 5
    actual: 12.5
```

**Преимущества:**
- Стандартизация кодов ошибок
- Централизованный каталог
- Интеграция с инцидентами
- Автоматическая классификация

---

## Чек-лист перед деплоем

- [ ] **step** соответствует типу метрики (5m для очередей, 15-30m для трендов)
- [ ] **for** достаточно для устойчивости (10-15m минимум)
- [ ] **Минимальный порог** отсекает фоновый шум
- [ ] **Мультипликатор** 2-3× для аномалий
- [ ] **WITH clause** для сложных вычислений
- [ ] **Защита от малых выборок** (двойное условие)
- [ ] **Cooldown** для группировки инцидентов
- [ ] **Аннотации** с понятным описанием и ссылками
- [ ] **Receivers** настроены на правильный канал
- [ ] **Recovery** включён для автоматического закрытия
- [ ] **Устойчивость** проверена на исторических данных (2-4 недели)
- [ ] **Тип алерта** соответствует задаче (Threshold/Anomaly/Processing Stopped)

---

## Ссылки

- [PromQL Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Sage Documentation](https://sage.tcsbank.ru/documentation)
- [ins-sre/alerts](https://gitlab.tcsbank.ru/ins-sre/alerts)
