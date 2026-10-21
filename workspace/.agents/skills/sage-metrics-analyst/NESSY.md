# NESSY.md — Контекст проекта Sage Metrics Analyst

## Обзор проекта

**Sage Metrics Analyst** — это скилл для Nessy CLI, предназначенный для анализа метрик и создания алертов в системе мониторинга Sage (на базе Prometheus). Скилл покрывает полный цикл работы с метриками: от исследования доступности метрик до деплоя готовых алертов.

### Основное назначение

- ✅ Проверка доступности метрик в Sage
- ✅ Исследование лейблов метрик (app, env, pod, status...)
- ✅ Анализ трендов за период (час/день/неделя)
- ✅ Создание алертов в YAML и JS форматах
- ✅ Валидация алертов на исторических данных
- ✅ Расследование инцидентов по метрикам

### Ключевые технологии

| Технология | Назначение |
|------------|------------|
| **PromQL** | Язык запросов к метрикам Prometheus |
| **MageQL** | Язык запросов к логам Sage |
| **YAML** | Декларативный формат алертов |
| **JavaScript** | Программный формат алертов |
| **Nessy CLI** | Фреймворк для скиллов |

---

## Структура проекта

```
sage-metrics-analyst/
├── SKILL.md              # Внутренняя документация скилла (методология, workflow)
├── README.md             # Быстрый старт и обзор возможностей
├── USAGE.md              # Подробное руководство с примерами
├── PATTERNS.md           # Каталог продвинутых паттернов алертов
├── NESSY.md              # Этот файл — контекст для Nessy CLI
├── policy.yml            # Политика GitLab (commit messages, branch names)
├── .gitlab-ci.yml        # CI/CD конфигурация
├── .gitlab-ci-compliance.yml  # Compliance шаблоны
├── .gitignore            # Игнорируемые файлы
├── approvers.yml         # Список аппруверов (не прочитан)
├── evals/
│   └── evals.json        # 52 тестовых кейса для триггеринга скилла
├── references/           # Справочные материалы (пусто)
└── scripts/              # Вспомогательные скрипты (пусто)
```

---

## Когда использовать скилл

**Обязательно применяй этот скилл, когда:**

| Триггер | Пример запроса |
|---------|---------------|
| "посмотри метрики" | "Посмотри метрики CPU для payments-api" |
| "создай алерт" | "Создай алерт на latency >500ms" |
| "проверь метрику в Sage" | "Проверь метрику http_requests_total" |
| "почему растёт latency" | "Почему растёт latency в auth-service?" |
| "проанализируй инцидент" | "Проанализируй спайк ошибок за вчера" |

**Не используй этот скилл для:**

- Поиска по логам (для этого `dp sage logs -g <group> -s <system>`)
- Общих вопросов про Kubernetes или инфраструктуру

---

## Рабочий процесс (Workflow)

### Шаг 1: Понимание задачи

Уточни контекст у пользователя:

1. **Какая система/сервис?** — tenant, namespace, app
2. **Какая метрика?** — имя метрики или тип
3. **Какая цель?** — исследовать, создать алерт, расследовать инцидент
4. **Есть ли инцидент?** — если да, запроси временной диапазон

### Шаг 2: Анализ метрик

**2.1. Проверка доступности метрики:**
```bash
dp sage query --query='pql <metric_name>' --hours=1
```

**2.2. Исследование лейблов:**
```bash
dp sage query --query='pql count by (<label_name>) (<metric_name>)' --hours=24
```

**2.3. Анализ данных за период:**
```bash
# Среднее значение за неделю
dp sage query --query='pql avg_over_time(rate(<metric_name>[5m])[7d])'

# Максимум за период инцидента
dp sage query --query='pql max by (<labels>) (<metric_name>)' --from=<start> --to=<end>
```

### Шаг 3: Создание запроса

**Типы запросов:**

| Тип | Когда использовать | Пример |
|-----|-------------------|--------|
| `rate()` | Для counter-метрик | `rate(metric[5m]) * 60` |
| `avg_over_time()` | Среднее за период | `avg_over_time(metric[1h])` |
| `max_over_time()` | Пиковые значения | `max_over_time(metric[1h])` |
| `histogram_quantile()` | Перцентили latency | `histogram_quantile(0.99, rate(...))` |
| `min_over_time()` | Устойчивость значения | `min_over_time((metric > 10)[5m])` |
| `WITH` | Сложные вычисления | `WITH (baseline = ..., current = ...)` |

### Шаг 4: Создание алерта

**Структура YAML-алерта:**
```yaml
labels:
  - name: <alerts-group-name>
    rules:
      - alert: "<AlertName>"
        expr: |
          pql step=30m
          WITH (...)
          <your-query>
        for: 15m          # Временное окно
        enabled: true
        metrics_enabled: true
        annotations:
          summary: "<Краткое описание>"
          description: "<Полное описание>"
          receivers:
            - name: slack:_CHANNEL_NAME_
          recovery_enabled: true
```

**Рекомендуемые параметры:**

| Параметр | Рекомендация | Обоснование |
|----------|-------------|-------------|
| **for** | 15m | Только устойчивые аномалии |
| **Мин. порог** | Зависит от метрики | Отсекает фоновый шум |
| **Мультипликатор** | 2-3× от baseline | Значимые отклонения |
| **step** | 5-15m | Для очередей и критичных метрик |
| **baseline** | 7 дней | Адаптация к поведению системы |

### Шаг 5: Валидация

**5.1. Тестирование на исторических данных:**
```bash
dp sage query --query='<your-query>' --from=<incident-start> --to=<incident-end>
```

**5.2. Проверка на ложные срабатывания:**
```bash
dp sage query --query='<your-query>' --hours=168
```

### Шаг 6: Деплой

**Через MR:**
1. Создать файл алерта в `src/alerts/yaml/<group>-alerts.yml`
2. Создать MR в ветку `master`
3. Дождаться прохождения pipeline
4. Замёржить MR (тестовые алерты удалятся автоматически)

---

## Типы метрик и подходы

| Тип метрики | Примеры | Подход | Пример |
|-------------|---------|--------|--------|
| **Counter** | `requests_total`, `errors_total` | `rate()[5m] * 60` | `rate(http_requests_total[5m]) * 60` |
| **Gauge** | `cpu_usage`, `memory_bytes` | Прямое значение | `container_memory_usage_bytes` |
| **Histogram** | `request_duration_seconds_bucket` | `histogram_quantile()` | `histogram_quantile(0.99, rate(...))` |
| **Summary** | `request_duration_seconds{quantile}` | Прямое | `http_request_duration_seconds{quantile="0.99"}` |

---

## Продвинутые паттерны

### 1. Временные фильтры (Time-based)

**Только рабочее время:**
```pql
and ON() hour() >= 9 and hour() < 18
```

**Только ночью:**
```pql
and on() ((hour() >= 20) or (hour() < 8))
```

### 2. Cooldown для группировки инцидентов

```yaml
annotations:
  cooldown_key: "{{ alert.id }} - {{hashFrom query.result 'AlertId'}}"
  cooldown_duration: 1200  # 20 минут
```

### 3. Устойчивость через `min_over_time`

```pql
min_over_time(
  (rate(error_total[5m]) > 10)[5m]
) >= 1  # Все 5 минут превышен порог
```

### 4. DRY с WITH clause

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

```pql
# Процент ошибок > 20%
(rate(errors[5m]) / rate(total[5m]) * 100) > 20
# И абсолютное число ошибок > 10
and increase(errors[5m]) > 10
```

### 6. Multi-level алертирование

```yaml
# Warning: 20% ошибок
- alert: "Error Rate Warning"
  expr: pql error_rate > 20
  for: 15m

# Critical: 50% ошибок
- alert: "Error Rate Critical"
  expr: pql error_rate > 50
  for: 5m
```

---

## Частые ошибки и решения

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

## Тестирование (Evals)

Проект содержит **52 тестовых кейса** в `evals/evals.json` для проверки триггеринга скилла:

**Категории тестов:**

| Категория | Количество | Примеры |
|-----------|------------|---------|
| Проверка метрик | 3 | check-metric-availability, validate-query-false-positives |
| Создание алертов | 25+ | CPU, memory, latency, error rate, queue backlog |
| Продвинутые паттерны | 10+ | Cooldown, min_over_time, DRY, multi-level |
| Временные фильтры | 3 | Business hours, night, weekends |
| Kubernetes метрики | 10+ | Pod restarts, HPA, PVC, DNS, Jobs |
| Инфраструктура | 5+ | Disk, SSL, BGP, backup, GPU |

**Запуск тестов:** (команда зависит от инфраструктуры Nessy CLI)

---

## Конвенции разработки

### Commit Messages

Согласно `policy.yml`, commit messages должны соответствовать Conventional Commits:

```
<type>(<scope>): <JIRA-ID> <description>

Примеры:
feat(alerts): DPIAM-123 add CPU usage alert for payments-api
fix(sage): DPIAM-456 fix syntax error in PromQL query
docs(readme): DPIAM-789 update usage examples
```

**Типы коммитов:** `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`

### Branch Names

```
^[A-Z]+-\d+((\-\w+)+|\-([A-Z][a-z0-9]+)+)$

Примеры:
DPIAM-123-add-cpu-alert
DPIAM-456-fix-promql-syntax
```

### Форматирование YAML-алертов

- Отступы: 2 пробела
- `for`: 10-15m для устойчивости
- `step`: 5m для очередей, 15-30m для трендов
- `enabled: true`, `metrics_enabled: true`
- `recovery_enabled: true` для автозакрытия

---

## Работа с графиками (Chart & Timechart)

### Команда `chart`

Используется для построения графиков где ось X — **числовое поле** или **`@timestamp`**:

```pql
# Количество логов по значениям поля inst
group="default" | chart count over inst

# По timestamp (аналог timechart)
group="default" | chart count over @timestamp

# С группировкой
group="default" | chart count over averagePing by dc
```

**Синтаксис:**
```
chart <span=<time-value>> <limit=N> <stats-func>(<field>) as <name> over <field> [by <field1>, <field2>]
```

**Параметры:**
- **`span`** — размер временного интервала (для @timestamp)
- **`limit`** — ограничение количества строк
- **`over`** — поле для оси X (обязательно)
- **`by`** — группировка по дополнительным полям

### Команда `timechart`

Используется для графиков где ось X — **`@timestamp`** (время):

```pql
# Количество логов во времени
group="default" | timechart count

# С группировкой по system
group="default" | timechart count by system

# Несколько функций
group="default" | timechart max(user.age) as oldest, min(user.age) as youngest

# Со span
group="default" | timechart span=30m count
```

**Синтаксис:**
```
timechart [span=<time-value>] [legend=json|custom] [limit=N] <stats-func>(<field>) as <name> [by <field1>, <field2>]
```

**Параметры:**
- **`span`** — размер временного интервала (по умолчанию рассчитывается автоматически)
- **`legend`** — формат легенды (`json` или пользовательский `"\{{env}}-\{{system}}"`)
- **`by`** — группировка для нескольких линий на графике

### Настройка легенды

**JSON формат:**
```pql
pql chart=sum legend=json sum(sage_score_total) by (cluster, env)
```

**Пользовательский формат:**
```pql
pql chart=sum legend="кластер \{{cluster}} - окружение \{{env}}" sum(sage_score_total) by (cluster, env)

group="default" | timechart legend="окружение \{{env}}, система \{{system}}" count by env, system
```

### Ограничения

- После команд агрегации (`chart`, `timechart`, `stats`) обрабатываются только первые **100 000 строк**
- Для `pql` с `chart`/`timechart` — ограничение **700 000 точек** на графике
- При агрегации по `@timestamp` используйте **абсолютный интервал поиска**

---

## Типы алертов в Sage

### 1. YAML Git (рекомендуется для простых условий)

**Структура:**
```yaml
apiVersion: v1
repositoryUrl: https://gitlab.tcsbank.ru/<tenant>/<project>
labels:
  - name: <group-name>
    rules:
      - alert: "<AlertName>"
        expr: pql step=1m <query>
        for: 5m
        enabled: true
        metrics_enabled: false
        annotations:
          summary: "<Описание>"
          description: "<Полное описание>"
          receivers:
            - name: time:i.ivanov
          grafana_url: <dashboard_url>
          runbook_url: <runbook_url>
```

**Преимущества:**
- Версионирование в Git
- Простой синтаксис
- Быстрый деплой через CI/CD

### 2. JavaScript (для сложной логики)

**Структура:**
```javascript
const info = {
  name: 'Alert Name',
  description: 'Description',
  enabled: true,
  metricsEnabled: true
};

async function trigger() {
  const query_start = '-30m';
  const query = `group=sage level="ERROR" | stats count`;
  
  const result = await mage({
    start: query_start,
    query: query
  });
  
  const error_count = result[0].count;
  
  if (error_count > 1000) {
    await sendAlert({
      address: "oncall:Sage",
      message: `Много ошибок: ${error_count}`,
      cooldownKey: "sage_common",
      cooldownDuration: 30*60,
      grafanaUrl: "<url>",
      runbookUrl: "<url>"
    });
  }
}

module.exports = { trigger, info };
```

**Функции:**
- **`mage({start, end, query})`** — выполнение поискового запроса
- **`sendAlert({address, message, cooldownKey, cooldownDuration, ...})`** — отправка оповещения
- **`groupConfig()`** — общие настройки для группы алертов

**Преимущества:**
- Несколько условий в одном алерте
- Программная логика
- Динамические сообщения

### 3. MageQL (для средних по сложности условий)

Создаются через UI Sage с использованием MageQL запросов.

### 4. Anomaly (для аномалий)

Используют машинное обучение для обнаружения аномалий в метриках.

---

## Troubleshooting алертов

### Ошибки в работе алертов

| Код ошибки | Описание | Решение |
|-----------|----------|---------|
| `CodeIssues` | Ошибки в JavaScript коде | Проверить код, наличие `sendAlert()` |
| `BrokenExecution` | Частые ошибки выполнения | Анализировать логи выполнения |
| `ExecutionTime` | Алерт выполняется слишком долго | Упростить запрос, разбить на несколько |
| `HighCpuUsage` | Высокое потребление CPU | Оптимизировать код, уменьшить regex |
| `HighMemoryUsage` | Высокое потребление RAM | Уменьшить объем данных в запросе |
| `MageRequestLimit` | Превышен лимит запросов к Mage | Максимум 7 запросов на запуск |
| `RunningInTimeout` | Таймаут выполнения | Оптимизировать запрос |
| `WasUnusedForTooLong` | Выключен > 1 месяца | Удалить или включить |
| `UnreachableAddresses` | Адрес доставки не найден | Проверить существование адреса |
| `BadSearchRequest` | Некорректный MageQL запрос | Исправить синтаксис запроса |
| `MageRowsFetchedLimit` | > 1000 точек в ответе | Уменьшить интервал или агрегировать |

### Диагностика проблем

**Проверка статуса алерта:**
- Желтый цвет — есть ошибки
- Красный цвет — критические проблемы

**Анализ логов выполнения:**
```pql
group="sage" system="manul" "was completed with warning" Scopes.AlertId="<alert-id>"
```

**Просмотр значений:**
- Кнопка "Показать значения" в UI алерта
- Показывает конкретные значения метрик, вызвавших срабатывание

---

## Продвинутые возможности MageQL

### Поиск по лейблам метрик

```pql
# Все лейблы метрики
pql labels(http_requests_total)

# Все значения лейбла
pql label_values(http_requests_total, env)
```

### Instant Query

Выполнение запроса в конкретной временной точке:

```pql
# Установить одинаковые Date from и Date to
pql up{group="sage", system="mage", env="prod"}
```

**Особенности:**
- `step` игнорируется (фиксированный = 5m)
- Возвращает значение только в указанной точке
- Полезно для `count_over_time` и других агрегаций

### Временные сдвиги (Time Shift)

```pql
# Сдвиг интервала в основном запросе
vars start_time="2024-05-08T14:00:00Z", end_time="2024-05-08T15:00:00Z"
| group="sage" system="mage" level="ERROR"
| eval date=var(start_time)
| timechart span=30m count by date

# Сдвиг в подзапросе через timeshift
vars start_time="2024-05-08T14:00:00Z", end_time="2024-05-08T15:00:00Z"
| group="sage" system="mage" level="ERROR"
| join timeshift=30m on _id {
    group="sage" system="mage" level="ERROR"
}
| timechart span=30m count

# Сдвиг через vars и date_add
vars start_time="2024-05-08T14:00:00Z", end_time="2024-05-08T15:00:00Z"
| group="sage" system="mage" level="ERROR"
| join on _id {
    vars start_time=date_add(var(start_time),30,"minute"), 
         end_time=date_add(var(end_time), 30, "minute")
    | group="sage" system="mage" level="ERROR"
}
| timechart span=30m count
```

### Группировка результатов

```pql
# По одному полю
group="default" | stats count by system

# По нескольким полям
group="default" | stats count by system, dc, inst

# Для графиков
group="default" | chart count over averagePing by dc
group="default" | timechart count by system
```

### Поиск с регулярными выражениями

```pql
# Извлечение через rex
group="default"
| rex field=message r'age":(?<ext_age>[\d]*),"'
| where ext_age!=null
```

### Wildcards и поиск по фразам

```pql
# Точная фраза (порядок важен)
group="default" "heartbeat message"

# Wildcard (постфикс)
group="default" "*her"

# Экранирование кавычек
group="default" unparsed='{"@timestamp":"2023-03-10T10:19:37.2941147+00:00"}'
```

### Join запросов

```pql
# Basic join
group="default"
| join on _id {
    group="default" level="ERROR"
}

# Join с timeshift
group="default"
| join timeshift=30m on _id {
    group="default"
}
```

---

## Best Practices из документации Sage

### Рекомендации по алертам

1. **Пороги срабатывания:**
   - Использовать `for: 5-15m` для устойчивости
   - Избегать слишком чувствительных порогов
   - Тестировать на исторических данных

2. **Оповещения:**
   - Указывать `grafana_url` и `runbook_url`
   - Использовать понятные `summary` и `description`
   - Настраивать `cooldown` для группировки

3. **Тестирование:**
   - Проверять на исторических данных (7+ дней)
   - Анализировать ложные срабатывания
   - Мониторить метрики выполнения алерта

### Оптимизация запросов

1. **Избегать:**
   - Слишком широких интервалов поиска
   - Избыточных полей в выводе
   - Сложных regex без необходимости

2. **Использовать:**
   - Фильтрацию по лейблам на ранних этапах
   - Агрегацию для уменьшения объема данных
   - `WITH` для переиспользования выражений

### ErrorHub алерты

Для алертов на ошибки приложений использовать ErrorHub поля:

```pql
# Поиск первого/последнего события
earliest(@timestamp) as first_event_timestamp
latest(event_id) as last_event_id

# Информация по отчету
latest(level) as level
latest(exception.values.type) as name
latest(exception.values.value) as message
latest(errorhub.report.status) as status

# Статистика
dc(event_id) as events_count
dc(user.id) as users_count
```

---

## Полезные ссылки

- [Sage User Docs UI](https://gitlab.tcsbank.ru/sage/user-docs-ui) — официальная документация
- [Sage API Auth](https://sage.tcsbank.ru/documentation/api_auth)
- [Sage Documentation](https://sage.tcsbank.ru/documentation)
- [Grafana](https://sage.tcsbank.ru/grafana)
- [PromQL Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [MetricsQL](https://docs.victoriametrics.com/MetricsQL.html)
- [GitLab репозиторий](ssh://git@gitlab.tcsbank.ru:7999/ins-sre/sage-metrics-analyst.git)

---

## Установка и запуск

### Установка скилла

```bash
npx @nessy/cli install ssh://git@gitlab.tcsbank.ru:7999/ins-sre/sage-metrics-analyst.git
```

### Проверка установки

Скилл автоматически активируется при триггер-фразах:
- "посмотри метрики..."
- "создай алерт..."
- "проверь метрику в Sage"
- "почему растёт latency"
- "проанализируй инцидент по метрикам"

### Деплой алертов

```bash
# Создать файл с токеном
echo "APITOKEN=<your-token>" > devconfig.env

# Загрузить переменные
set -a && . ./devconfig.env

# Задеплоить
npm run deploy
```

---

## Выходной формат

Всегда предоставляй результат в этом порядке:

1. **План** — краткое описание шагов
2. **Запрос** — готовый PromQL/MageQL запрос
3. **Результаты** — вывод запроса с интерпретацией
4. **YAML-алерт** (если требуется) — готовая конфигурация
5. **Рекомендации** — следующие шаги
