---
title: Наблюдаемость с OpenTelemetry
---

# Наблюдаемость с OpenTelemetry

Узнайте, как включить и настроить OpenTelemetry для Nessy CLI.

- [Наблюдаемость с OpenTelemetry](#наблюдаемость-с-opentelemetry)
  - [Ключевые преимущества](#ключевые-преимущества)
  - [Интеграция с OpenTelemetry](#интеграция-с-opentelemetry)
  - [Конфигурация](#конфигурация)
  - [Атрибуты ресурса](#атрибуты-ресурса)
    - [Примеры](#примеры)
    - [Зарезервированные ключи](#зарезервированные-ключи)
    - [Формат](#формат)
    - [Устранение неполадок: когда пользовательский атрибут не применяется](#устранение-неполадок-когда-пользовательский-атрибут-не-применяется)
  - [Контроль кардинальности](#контроль-кардинальности)
    - [`telemetry.metrics.includeSessionId` (по умолчанию: `false`)](#telemetrymetricsincludesessionid-по-умолчанию-false)
    - [Миграция с более ранних версий](#миграция-с-более-ранних-версий)
  - [Клиентский HTTP span для исходящих fetch-запросов](#клиентский-http-span-для-исходящих-fetch-запросов)
  - [Исходящая корреляция (БЕЗОПАСНОСТЬ)](#исходящая-корреляция-безопасность)
    - [`outboundCorrelation.propagateTraceContext`](#outboundcorrelationpropagatetracecontext)
    - [Другие заголовки исходящей корреляции](#другие-заголовки-исходящей-корреляции)
  - [Aliyun Telemetry](#aliyun-telemetry)
    - [Ручной OTLP экспорт](#ручной-otlp-экспорт)
  - [Локальная телеметрия](#локальная-телеметрия)
    - [Вывод на основе файлов (рекомендуется)](#вывод-на-основе-файлов-рекомендуется)
    - [Экспорт через коллектор (продвинутый)](#экспорт-через-коллектор-продвинутый)
  - [Логи и метрики](#логи-и-метрики)
    - [Логи](#логи)
    - [Метрики](#метрики)

## Ключевые преимущества

- **🔍 Аналитика использования**: Понимание паттернов взаимодействия и использования функций в вашей команде
- **⚡ Мониторинг производительности**: Отслеживание времени отклика, потребления токенов и использования ресурсов
- **🐛 Отладка в реальном времени**: Выявление узких мест, сбоев и паттернов ошибок по мере их возникновения
- **📊 Оптимизация рабочих процессов**: Принятие обоснованных решений для улучшения конфигураций и процессов
- **🏢 Корпоративное управление**: Мониторинг использования в командах, отслеживание затрат, обеспечение соответствия и интеграция с существующей инфраструктурой мониторинга

## Интеграция с OpenTelemetry

Построенная на **[OpenTelemetry]** — вендор-нейтральной, отраслевой стандартной системе наблюдаемости — система наблюдаемости Nessy CLI предоставляет:

- **Универсальная совместимость**: Экспорт в любой OpenTelemetry бэкенд (Aliyun, Jaeger, Prometheus, Datadog и т.д.)
- **Стандартизированные данные**: Использование согласованных форматов и методов сбора во всём инструментарии
- **Будущее-proof интеграция**: Подключение к существующей и будущей инфраструктуре наблюдаемости
- **Без vendor lock-in**: Переключение между бэкендами без изменения вашей инструментации

[OpenTelemetry]: https://opentelemetry.io/
[aliyun-opentelemetry-overview]: https://www.alibabacloud.com/help/en/arms/tracing-analysis/product-overview/what-is-tracing-analysis
[aliyun-opentelemetry-get-started]: https://www.alibabacloud.com/help/en/arms/tracing-analysis/before-you-begin
[aliyun-opentelemetry-console-cn]: https://trace.console.aliyun.com
[aliyun-opentelemetry-console-cn-legacy]: https://tracing.console.aliyun.com
[aliyun-opentelemetry-console-intl]: https://arms.console.alibabacloud.com

## Конфигурация

Всё поведение телеметрии контролируется через ваш файл `.nessy/settings.json`. Эти настройки могут быть переопределены переменными окружения или флагами CLI.

| Настройка                        | Переменная окружения                                | Флаг CLI                                                 | Описание                                                                                                                                                           | Значения          | По умолчанию            |
| -------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------- |
| `enabled`                        | `NESSY_TELEMETRY_ENABLED`                           | `--telemetry` / `--no-telemetry`                         | Включить или отключить телеметрию                                                                                                                                  | `true`/`false`    | `false`                 |
| `target`                         | `NESSY_TELEMETRY_TARGET`                            | `--telemetry-target <local\|gcp>` _(устарел)_            | Информационная метка назначения; не управляет маршрутизацией экспорта — установите `otlpEndpoint` или `outfile` для настройки куда отправляются данные             | `"gcp"`/`"local"` | `"local"`               |
| `otlpEndpoint`                   | `NESSY_TELEMETRY_OTLP_ENDPOINT`                     | `--telemetry-otlp-endpoint <URL>`                        | Эндпоинт OTLP коллектора                                                                                                                                           | URL строка        | `http://localhost:4317` |
| `otlpProtocol`                   | `NESSY_TELEMETRY_OTLP_PROTOCOL`                     | `--telemetry-otlp-protocol <grpc\|http>`                 | Транспортный протокол OTLP                                                                                                                                         | `"grpc"`/`"http"` | `"grpc"`                |
| `otlpTracesEndpoint`             | `NESSY_TELEMETRY_OTLP_TRACES_ENDPOINT`              | —                                                        | Переопределение эндпоинта для трассировок (только HTTP)                                                                                                            | URL строка        | —                       |
| `otlpLogsEndpoint`               | `NESSY_TELEMETRY_OTLP_LOGS_ENDPOINT`                | —                                                        | Переопределение эндпоинта для логов (только HTTP)                                                                                                                  | URL строка        | —                       |
| `otlpMetricsEndpoint`            | `NESSY_TELEMETRY_OTLP_METRICS_ENDPOINT`             | —                                                        | Переопределение эндпоинта для метрик (только HTTP)                                                                                                                 | URL строка        | —                       |
| `outfile`                        | `NESSY_TELEMETRY_OUTFILE`                           | `--telemetry-outfile <path>`                             | Сохранить телеметрию в файл (переопределяет OTLP экспорт)                                                                                                          | путь к файлу      | —                       |
| `logPrompts`                     | `NESSY_TELEMETRY_LOG_PROMPTS`                       | `--telemetry-log-prompts` / `--no-telemetry-log-prompts` | Включать подсказки в логи телеметрии                                                                                                                               | `true`/`false`    | `true`                  |
| `includeSensitiveSpanAttributes` | `NESSY_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES` | —                                                        | Включать подсказки пользователя, системные подсказки, ввод/вывод инструментов и вывод модели как нативные атрибуты span (в дополнение к span-ам моста log-to-span) | `true`/`false`    | `false`                 |
| `resourceAttributes`             | `OTEL_RESOURCE_ATTRIBUTES` (+ `OTEL_SERVICE_NAME`)  | —                                                        | Статические атрибуты ресурса, прикрепляемые к каждому экспортированному span/log/metric. См. [Атрибуты ресурса](#атрибуты-ресурса) ниже.                           | `key=value,…`     | `{}`                    |
| `metrics.includeSessionId`       | `NESSY_TELEMETRY_METRICS_INCLUDE_SESSION_ID`        | —                                                        | Включать `session.id` в точки данных метрик. **Отключено по умолчанию** для защиты бэкендов метрик от раздувания временных рядов.                                  | `true`/`false`    | `false`                 |

**Примечание о булевых переменных окружения:** Для булевых настроек (`enabled`, `logPrompts`, `includeSensitiveSpanAttributes`), установка соответствующей переменной окружения в `true` или `1` включит функцию. Любое другое значение отключит её.

**Чувствительные атрибуты span:** Когда `includeSensitiveSpanAttributes` включён, происходят две вещи:

1. **Нативные атрибуты span** (`nessy-cli.interaction`, `api.generateContent*`, `tool.<name>`) содержат дословное содержимое разговора:
   - Подсказки пользователя (`new_context`)
   - Системные подсказки (`system_prompt` — полный текст один раз за сессию, дедуплицируется по SHA-256 хэшу; последующие span несут только `system_prompt_hash` + `system_prompt_preview` + `system_prompt_length`)
   - Схемы инструментов (испускаются как события `tool_schema`, также хэш-дедуплицируются)
   - Ввод инструментов (`tool_input`) и результаты инструментов (`tool_result`)
   - Вывод модели (`response.model_output`)

   Каждое значение обрезается до 60 КБ; флаги `*_truncated` и `*_original_length` сигнализируют о обрезке.

2. **Span-ы моста log-to-span** (используются при экспорте HTTP трассировок без эндпоинта логов) сохраняют свои существующие поля `prompt`, `function_args` и `response_text` вместо того чтобы быть отброшенными.

⚠️ **Предупреждение о безопасности:** включение этого флага передаёт полную историю разговора, содержимое файлов, прочитанных `read_file`, команды shell и их вывод (включая секреты в переменных окружения или аргументах) и ответы модели в настроенный OTLP бэкенд. Считайте бэкенд привилегированным приёмником данных. Флаг по умолчанию `false`.

**Стоимость / размер полезной нагрузки:** Тяжёлый поворот (60 КБ системная подсказка + 10 вызовов инструментов, каждый до 60 КБ ввод + 60 КБ результат, плюс 60 КБ вывод модели) может произвести до ~1.5 МБ полезной нагрузки атрибутов перед OTLP сжатием. При нацеливании инструментов, читающих большие файлы (`read_file` и т.д.), на долгоживущие сессии, отслеживайте пропускную способность экспортера.

Эта настройка не отключает чувствительные данные в логах OTel или других приёмниках телеметрии; не внутренняя телеметрия API ответов может заполнять `response_text`, поэтому логи OTel, телеметрия UI и запись чата могут получать текст ответа независимо от этой настройки. NessyLogger не включает `response_text`.

**Маршрутизация сигналов HTTP OTLP:** При использовании протокола HTTP (`otlpProtocol: "http"`), Nessy CLI автоматически добавляет специфичные для сигнала пути (`/v1/traces`, `/v1/logs`, `/v1/metrics`) к базовому `otlpEndpoint`. Например, `http://collector:4318` становится `http://collector:4318/v1/traces` для трассировок. Если URL уже заканчивается путём сигнала, он используется как есть. Переопределения эндпоинтов для сигналов (`otlpTracesEndpoint` и т.д.) имеют приоритет над базовым эндпоинтом и используются дословно. Протокол gRPC использует маршрутизацию на основе сервиса и не добавляет пути.

Переменные окружения эндпоинтов для сигналов также принимают стандартные имена OpenTelemetry: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. Варианты `NESSY_TELEMETRY_OTLP_*` имеют приоритет над вариантами `OTEL_*`.

Для детальной информации обо всех опциях конфигурации смотрите [Руководство по конфигурации](../../../users/work/configuration/settings.md).

## Атрибуты ресурса

Атрибуты ресурса — это статические пары ключ-значение, прикрепляемые к каждому span, логу и метрике, экспортируемым через OTLP. Используйте их для разделения телеметрии по команде, окружению, региону развёртывания или любому другому измерению, которое важно для вашего бэкенда.

Два источника, объединённые в порядке приоритета (низший → высший):

1. Стандартная переменная окружения `OTEL_RESOURCE_ATTRIBUTES`
2. `telemetry.resourceAttributes` в `.nessy/settings.json` (переопределяет переменную окружения при конфликте ключей)

`OTEL_SERVICE_NAME` — это отдельный обходной путь — при установке переопределяет `service.name` из любого источника (согласно спецификации OpenTelemetry).

### Примеры

**Разделение всей телеметрии по команде / окружению:**

```bash
export OTEL_RESOURCE_ATTRIBUTES="team=platform,env=prod,cost_center=eng-123"
```

**Маршрутизация к коллектору на тенанта через `service.name`:**

```bash
export OTEL_SERVICE_NAME=nessy-cli-ci
```

**Базовый уровень флота (`~/.nessy/settings.json`) + переопределение на хост:**

```json
{
  "telemetry": {
    "resourceAttributes": {
      "deployment.environment": "production",
      "service.namespace": "engineering-tooling"
    }
  }
}
```

```bash
# Добавить одноразовый тег без касания настроек:
export OTEL_RESOURCE_ATTRIBUTES="debug_run=true"
```

### Зарезервированные ключи

Некоторые ключи управляются во время выполнения и не могут быть переопределены:

- `service.version` — всегда устанавливается в версию запущенного CLI. Установка из любого источника молча отбрасывается с предупреждением.
- `session.id` — внедряется во время выполнения для каждой сессии. Пользовательские значения из переменных окружения или настроек отбрасываются с предупреждением. Причина в том, что атрибуты ресурса автоматически прикрепляются к каждой точке данных метрики; разрешение переопределения пользователем обойдёт [Контроль кардинальности](#контроль-кардинальности) ниже. Span-ы и логи всегда несут `session.id`.

`service.name` **не** зарезервирован; следует цепочке приоритетов выше.

### Формат

`OTEL_RESOURCE_ATTRIBUTES` следует спецификации OpenTelemetry: `key1=value1,key2=value2` с процентамированными значениями. Пробелы в значениях должны быть закодированы как `%20`, **запятые как `%2C`** (незакодированные запятые разделяют значение на неправильной границе, и вторая половина отбрасывается как некорректная). Некорректные пары пропускаются с предупреждением вместо отказа запуска телеметрии.

### Устранение неполадок: когда пользовательский атрибут не применяется

Зарезервированные ключи (`service.version`, `session.id`), некорректные пары, не строковые значения настроек и некорректное процентирование молча отбрасываются с предупреждением, логируемым через канал диагностики OpenTelemetry. Этот канал маршрутизируется в файл отладочного лога (`~/.nessy/log/otel-*.log`), **не** в консоль, поэтому поведение может выглядеть как молчаливый отказ.

Если пользовательский атрибут ресурса не появляется в экспортируемой телеметрии:

1. Проверьте `~/.nessy/log/otel-*.log` на строки, соответствующие `cannot override` (зарезервированный ключ отброшен), `Skipping malformed` (некорректная пара переменной окружения) или `must be a string` (не строковое значение настроек).
2. Убедитесь, что переменная окружения установлена в окружении процесса nessy-cli (не только вашего shell) и что значения процентамированы.
3. Подтвердите, что `telemetry.enabled` равно `true` — инициализация телеметрии запускается только если включена.

## Контроль кардинальности

Метрики агрегируются по набору атрибутов на бэкенде — каждая различная комбинация значений атрибутов создаёт новый временной ряд. Прикрепление высокоскоростного поля как `session.id` к метрике вызывает раздувание временных рядов пропорционально количеству сессий, что быстро исчерпывает хранилище метрик бэкенда.

Чтобы предотвратить это, Nessy CLI по умолчанию держит высокоскоростные атрибуты вне точек данных метрик. Span-ы и логи — это по-событийные и незатронутые, поэтому они продолжают нести `session.id` для корреляции трассировок и логов.

### `telemetry.metrics.includeSessionId` (по умолчанию: `false`)

Установка этого в `true` (через настройки или `NESSY_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true`) повторно прикрепляет `session.id` к каждой точке данных метрики.

⚠️ **Предупреждение:** каждая сессия CLI создаёт новое значение. Оставление этого включённым для флота взорвёт хранилище метрик. Рекомендуется только для краткосрочной отладки. Для долгосрочной корреляции сессий, используйте трассировки или логи бэкенды вместо этого.

### Миграция с более ранних версий

До этого релиза `session.id` прикреплялся к метрикам по умолчанию. Если ваши запросы Prometheus / Grafana дашборды / правила алертинга ссылаются на `session_id` на метрике, у вас есть два варианта:

**Опция A** — восстановить предыдущее поведение для краткосрочной отладки:

```bash
export NESSY_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true
```

или:

```json
{
  "telemetry": {
    "metrics": { "includeSessionId": true }
  }
}
```

**Опция B (рекомендуется)** — переместить анализ уровня сессий с метрик. Span-ы и логи всё ещё несут `session.id`, и трассировки / логи бэкенды (Jaeger, Tempo, Loki, Aliyun SLS / ARMS Tracing) обрабатывают разделение на сессии нативно без давления кардинальности.

## Клиентский HTTP span для исходящих fetch-запросов

Когда телеметрия включена, Nessy CLI регистрирует `UndiciInstrumentation`, который создаёт клиентский HTTP span для каждого исходящего запроса `fetch()`, инициированного процессом — включая LLM SDK (`openai`, `@google/genai`, `@anthropic-ai/sdk`), MCP StreamableHTTP клиент, инструмент `WebFetch` и любые вызовы расширения IDE из отдельного процесса. Span позволяет увидеть сетевую задержку (TTFB / передача тела ответа) отдельно от времени обработки модели upstream, которое один существующий span `api.generateContent` не может различить.

Эти span-ы идут в **ваш** OTLP коллектор (или файл outfile) как и остальная телеметрия — они не влияют на то, что записывается в исходящий HTTP запрос. Запись заголовка W3C `traceparent` в исходящий поток запроса контролируется **отдельной, важной для безопасности настройкой**, документированной в [исходящей корреляции](#исходящая-корреляция-безопасность) ниже.

**Избегание петли обратной связи.** OTel SDK использует `fetch` внутри для загрузки данных OTLP. Без защиты инструментация `fetch` отслеживала бы эти загрузки, которые сами были бы загружены, вызывая бесконечный цикл. Инструментация undici в Nessy CLI настроена с `ignoreRequestHook`, который пропускает URL, соответствующие префиксам настроенных `telemetry.otlpEndpoint` / `telemetry.otlpTracesEndpoint` / `telemetry.otlpLogsEndpoint` / `telemetry.otlpMetricsEndpoint`. В режиме file-outfile нет исходящих HTTP загрузок, поэтому hook — это no-op.

## Исходящая корреляция (БЕЗОПАСНОСТЬ)

Эти настройки живут в **отдельном пространстве имён верхнего уровня** от `telemetry.*` намеренно: телеметрия контролирует поток данных в собственный бэкенд наблюдаемости оператора, в то время как `outboundCorrelation.*` контролирует, какие данные корреляции на стороне клиента nessy-cli записывает **в исходящие потоки запросов LLM API**, которые достигают сторонних эндпоинтов LLM провайдеров (DashScope, OpenAI, Anthropic и т.д.). Разные получатели, разное решение о согласии. **Все значения по умолчанию отключены.** См. обсуждение обзора PR #4390 для обоснования.

### `outboundCorrelation.propagateTraceContext`

```jsonc
"outboundCorrelation": {
  "propagateTraceContext": false // по умолчанию
}
```

Когда `false` (по умолчанию), Nessy CLI устанавливает no-op `TextMapPropagator` на OTel SDK. UndiciInstrumentation всё ещё создаёт клиентские HTTP span-ы для вашего OTLP коллектора, но `propagation.inject()` — это no-op, поэтому **никакой `traceparent` не записывается в исходящие запросы**. Trace ID остаются внутренними для коллектора оператора.

Когда `true`, стандартный W3C композитный пропагатор SDK (`tracecontext` + `baggage`) устанавливается, и стандартный заголовок `traceparent` записывается в каждый исходящий `fetch`:

```
traceparent: 00-<32-hex traceId>-<16-hex parentSpanId>-<01-sampled | 00-not-sampled>
```

Включайте опционально, когда LLM провайдер также отчитывается в ваш OTel коллектор для межпроцессной сшивки трассировок — например, ARMS Tracing, обслуживающий DashScope. Для большинства операторов значение — `false`; кросс-вендор продолжение трассировок — это ниша.

**Зависит от `telemetry.enabled: true`.** OTel SDK инициализируется только когда телеметрия включена, поэтому `propagateTraceContext` работает только в этом состоянии. Установка в `true` при отключённой телеметрии — это молчаливый no-op — нет SDK, нет пропагатора, нет `traceparent` в сети. Проверьте оба флага при настройке корреляции ARMS+DashScope:

```jsonc
{
  "telemetry": {
    "enabled": true,
    "otlpTracesEndpoint": "http://tracing-analysis-...",
  },
  "outboundCorrelation": {
    "propagateTraceContext": true,
  },
}
```

### Другие заголовки исходящей корреляции

`X-Nessy-Cli-Session-Id` и `X-Nessy-Cli-Request-Id` **не являются частью этого PR**. Они будут спроектированы и предложены в своих собственных follow-up PR(s) под тем же пространством имён `outboundCorrelation.*`, каждое со своей собственной моделью угроз и потоком согласия оператора. Обзор PR #4390 (LaZzyMan) установил принцип: «область работы телеметрии не включает отправку идентификаторов LLM провайдерам»; работа над заголовками корреляции перемещается в отдельное обсуждение дизайна, а не приземляется под телеметрию.

## Aliyun Telemetry

### Ручной OTLP экспорт

Для просмотра телеметрии Nessy CLI в Alibaba Cloud Managed Service for OpenTelemetry, настройте Nessy CLI для экспорта к OTLP эндпоинту, предоставленному ARMS.

Установка только `"target": "gcp"` не настраивает назначение экспорта. Если `otlpEndpoint` не установлен, Nessy CLI всё ещё по умолчанию использует `http://localhost:4317`. Если `outfile` установлен, он переопределяет `otlpEndpoint` и телеметрия записывается в файл вместо отправки в Alibaba Cloud.

1. Включите телеметрию в вашем `.nessy/settings.json` и установите OTLP эндпоинт:

   **Опция A: Протокол gRPC** (стандартный OTLP эндпоинт):

   ```json
   {
     "telemetry": {
       "enabled": true,
       "target": "gcp",
       "otlpEndpoint": "https://<your-otlp-endpoint>",
       "otlpProtocol": "grpc"
     }
   }
   ```

   **Опция B: Протокол HTTP с эндпоинтами для сигналов** (для бэкендов, использующих нестандартные пути, например `/api/otlp/traces` вместо `/v1/traces`):

   ```json
   {
     "telemetry": {
       "enabled": true,
       "otlpProtocol": "http",
       "otlpTracesEndpoint": "http://<host>/<token>/api/otlp/traces",
       "otlpLogsEndpoint": "http://<host>/<token>/api/otlp/logs",
       "otlpMetricsEndpoint": "http://<host>/<token>/api/otlp/metrics"
     }
   }
   ```

   > **Примечание:** При использовании протокола HTTP только с `otlpEndpoint` (без переопределений для сигналов), Nessy CLI добавляет стандартные OTLP пути (`/v1/traces`, `/v1/logs`, `/v1/metrics`) к базовому URL. Если ваш бэкенд использует различные пути, используйте переопределения эндпоинтов для сигналов, как показано в Опции B.

2. Если ваш эндпоинт Alibaba Cloud требует аутентификации, предоставьте заголовки OTLP через стандартные переменные окружения OpenTelemetry, такие как `OTEL_EXPORTER_OTLP_HEADERS` (или специфичные для сигналов варианты). Nessy CLI в настоящее время не предоставляет заголовки аутентификации OTLP напрямую в `.nessy/settings.json`.
3. Запустите Nessy CLI и отправьте подсказки.
4. Просмотрите телеметрию в Managed Service for OpenTelemetry:
   - Product overview: [What is Managed Service for OpenTelemetry?][aliyun-opentelemetry-overview]
   - Getting started: [Get started with Managed Service for OpenTelemetry][aliyun-opentelemetry-get-started]
   - Console entry points:
     - China mainland: [trace.console.aliyun.com][aliyun-opentelemetry-console-cn] (legacy console: [tracing.console.aliyun.com][aliyun-opentelemetry-console-cn-legacy])
     - International: [arms.console.alibabacloud.com][aliyun-opentelemetry-console-intl]
   - В консоли используйте `Applications` для инспекции трассировок и топологии сервиса.
   - Для поиска информации об эндпоинте OTLP и доступе:
     - **Новая консоль** (`trace.console.aliyun.com` или international): перейдите в `Integration Center`.
     - **Legacy консоль** (`tracing.console.aliyun.com`): перейдите в `Cluster Configurations` → `Access point information`.

## Локальная телеметрия

Для локальной разработки и отладки вы можете захватывать данные телеметрии локально:

### Вывод на основе файлов (рекомендуется)

1. Включите телеметрию в вашем `.nessy/settings.json`:

   ```json
   {
     "telemetry": {
       "enabled": true,
       "outfile": ".nessy/telemetry.log"
     }
   }
   ```

   > **Примечание:** Когда `outfile` установлен, OTLP экспорт автоматически отключается. Настройки `target` и `otlpEndpoint` не нужны для вывода только в файл и могут быть безопасно опущены из вашей конфигурации.

2. Запустите Nessy CLI и отправьте подсказки.
3. Просмотрите логи и метрики в указанном файле (например, `.nessy/telemetry.log`).

### Экспорт через коллектор (продвинутый)

1. Запустите скрипт автоматизации:
   ```bash
   npm run telemetry -- --target=local
   ```
   Это выполнит:
   - Загрузку и запуск Jaeger и OTEL коллектора
   - Конфигурацию вашего рабочего пространства для локальной телеметрии
   - Предоставление Jaeger UI по адресу http://localhost:16686
   - Сохранение логов/метрик в `~/.nessy/tmp/<projectHash>/otel/collector.log`
   - Остановку коллектора при выходе (например, `Ctrl+C`)
2. Запустите Nessy CLI и отправьте подсказки.
3. Просмотрите трассировки по адресу http://localhost:16686 и логи/метрики в файле лога коллектора.

## Логи и метрики

Следующий раздел описывает структуру логов и метрик, генерируемых для Nessy CLI.

- `sessionId` включается как общий атрибут во все логи и метрики.

### Логи

Логи — это записанные с временными метками записи о специфичных событиях. Следующие события логируются для Nessy CLI:

- `nessy-cli.config`: Это событие происходит один раз при запуске с конфигурацией CLI.
  - **Атрибуты**:
    - `model` (string)
    - `sandbox_enabled` (boolean)
    - `core_tools_enabled` (string)
    - `approval_mode` (string)
    - `file_filtering_respect_git_ignore` (boolean)
    - `debug_mode` (boolean)
    - `truncate_tool_output_threshold` (number)
    - `truncate_tool_output_lines` (number)
    - `hooks` (string, разделённые запятыми типы событий хуков, опущено если хуки отключены)
    - `ide_enabled` (boolean)
    - `interactive_shell_enabled` (boolean)
    - `mcp_servers` (string)
    - `output_format` (string: "text" или "json")

- `nessy-cli.user_prompt`: Это событие происходит, когда пользователь отправляет подсказку.
  - **Атрибуты**:
    - `prompt_length` (int)
    - `prompt_id` (string)
    - `prompt` (string, этот атрибут исключается если `log_prompts_enabled` настроено в `false`)
    - `auth_type` (string)

- `nessy-cli.tool_call`: Это событие происходит для каждого вызова функции.
  - **Атрибуты**:
    - `function_name`
    - `function_args`
    - `duration_ms`
    - `success` (boolean)
    - `decision` (string: "accept", "reject", "auto_accept" или "modify", если применимо)
    - `error` (если применимо)
    - `error_type` (если применимо)
    - `content_length` (int, если применимо)
    - `metadata` (если применимо, словарь string -> any)

- `nessy-cli.file_operation`: Это событие происходит для каждой файловой операции.
  - **Атрибуты**:
    - `tool_name` (string)
    - `operation` (string: "create", "read", "update")
    - `lines` (int, если применимо)
    - `mimetype` (string, если применимо)
    - `extension` (string, если применимо)
    - `programming_language` (string, если применимо)
    - `diff_stat` (json string, если применимо): JSON строка со следующими полями:
      - `ai_added_lines` (int)
      - `ai_removed_lines` (int)
      - `user_added_lines` (int)
      - `user_removed_lines` (int)

- `nessy-cli.api_request`: Это событие происходит при выполнении запроса к Nessy API.
  - **Атрибуты**:
    - `model`
    - `request_text` (если применимо)

- `nessy-cli.api_error`: Это событие происходит, если запрос API не удался.
  - **Атрибуты**:
    - `model`
    - `error`
    - `error_type`
    - `status_code`
    - `duration_ms`
    - `auth_type`

- `nessy-cli.api_response`: Это событие происходит при получении ответа от Nessy API.
  - **Атрибуты**:
    - `model`
    - `status_code`
    - `duration_ms`
    - `error` (опционально)
    - `input_token_count`
    - `output_token_count`
    - `cached_content_token_count`
    - `thoughts_token_count`
    - `response_text` (если применимо)
    - `auth_type`

- `nessy-cli.tool_output_truncated`: Это событие происходит, когда вывод вызова инструмента слишком большой и обрезается.
  - **Атрибуты**:
    - `tool_name` (string)
    - `original_content_length` (int)
    - `truncated_content_length` (int)
    - `threshold` (int)
    - `lines` (int)
    - `prompt_id` (string)

- `nessy-cli.malformed_json_response`: Это событие происходит, когда ответ `generateJson` от Nessy API не может быть разобран как JSON.
  - **Атрибуты**:
    - `model`

- `nessy-cli.flash_fallback`: Это событие происходит, когда Nessy CLI переключается на flash как резервный вариант.
  - **Атрибуты**:
    - `auth_type`

- `nessy-cli.slash_command`: Это событие происходит, когда пользователь выполняет slash-команду.
  - **Атрибуты**:
    - `command` (string)
    - `subcommand` (string, если применимо)

- `nessy-cli.extension_enable`: Это событие происходит, когда расширение включается
- `nessy-cli.extension_install`: Это событие происходит, когда расширение устанавливается
  - **Атрибуты**:
    - `extension_name` (string)
    - `extension_version` (string)
    - `extension_source` (string)
    - `status` (string)
- `nessy-cli.extension_uninstall`: Это событие происходит, когда расширение удаляется

### Метрики

Метрики — это числовые измерения поведения во времени. Следующие метрики собираются для Nessy CLI (имена метрик остаются `nessy-cli.*` для совместимости):

- `nessy-cli.session.count` (Counter, Int): Увеличивается один раз за запуск CLI.

- `nessy-cli.tool.call.count` (Counter, Int): Считает вызовы инструментов.
  - **Атрибуты**:
    - `function_name`
    - `success` (boolean)
    - `decision` (string: "accept", "reject" или "modify", если применимо)
    - `tool_type` (string: "mcp" или "native", если применимо)

- `nessy-cli.tool.call.latency` (Histogram, ms): Измеряет задержку вызова инструмента.
  - **Атрибуты**:
    - `function_name`
    - `decision` (string: "accept", "reject" или "modify", если применимо)

- `nessy-cli.api.request.count` (Counter, Int): Считает все запросы API.
  - **Атрибуты**:
    - `model`
    - `status_code`
    - `error_type` (если применимо)

- `nessy-cli.api.request.latency` (Histogram, ms): Измеряет задержку запроса API.
  - **Атрибуты**:
    - `model`

- `nessy-cli.token.usage` (Counter, Int): Считает количество использованных токенов.
  - **Атрибуты**:
    - `model`
    - `type` (string: "input", "output", "thought", "cache" или "tool")

- `nessy-cli.file.operation.count` (Counter, Int): Считает файловые операции.
  - **Атрибуты**:
    - `operation` (string: "create", "read", "update"): Тип файловой операции.
    - `lines` (Int, если применимо): Количество строк в файле.
    - `mimetype` (string, если применимо): Mimetype файла.
    - `extension` (string, если применимо): Расширение файла.
    - `model_added_lines` (Int, если применимо): Количество строк, добавленных/изменённых моделью.
    - `model_removed_lines` (Int, если применимо): Количество строк, удалённых/изменённых моделью.
    - `user_added_lines` (Int, если применимо): Количество строк, добавленных/изменённых пользователем в изменениях, предложенных ИИ.
    - `user_removed_lines` (Int, если применимо): Количество строк, удалённых/изменённых пользователем в изменениях, предложенных ИИ.
    - `programming_language` (string, если применимо): Язык программирования файла.

- `nessy-cli.chat_compression` (Counter, Int): Считает операции сжатия чата
  - **Атрибуты**:
    - `tokens_before`: (Int): Количество токенов в контексте до сжатия
    - `tokens_after`: (Int): Количество токенов в контексте после сжатия
