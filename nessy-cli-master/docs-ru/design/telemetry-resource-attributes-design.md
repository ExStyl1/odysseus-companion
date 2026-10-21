# Телеметрия: Custom Resource Attributes + Контроль кардинальности метрик

## 1. Фон

nessy-cli уже интегрирован с OpenTelemetry SDK, но способ построения Resource делает его непригодным для двух распространённых production сценариев:

1. **Невозможно добавить custom измерения**: operations хочет добавлять теги `team` / `env` / `cost_center` / `user_id` ко всем telemetry данным, сегодня нет никакого механизма для этого. Даже установка стандартного `OTEL_RESOURCE_ATTRIBUTES` environment variable **полностью не работает**.
2. **Выход из-под контроля кардинальности (cardinality) метрик**: `session.id` инжектируется на уровень Resource, автоматически прикрепляясь к каждой точке данных metric. Каждый CLI session генерирует новое значение, metrics backend (Prometheus / Alibaba Cloud ARMS Metric / VictoriaMetrics) будет перегружен unbounded time-series.

Эти две проблемы связаны: решение первой позволит пользователям **легче** добавлять high-cardinality поля к данным, поэтому необходимо предоставить второе.

## 2. Текущее состояние

### 2.1 Построение Resource

`packages/core/src/telemetry/sdk.ts:156-161`:

```ts
const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  [SemanticResourceAttributes.SERVICE_VERSION]:
    config.getCliVersion() || 'unknown',
  'session.id': config.getSessionId(),
});
```

`sdk.ts:274-278`:

```ts
sdk = new NodeSDK({
  resource,
  // Отключить async host/process/env resource detectors: они оставляют атрибуты
  // pending и триггерят OTel diag.error на любом чтении атрибута resource
  // до того как detectors settle (например, во время HttpInstrumentation span creation).
  autoDetectResources: false,
  ...
});
```

`autoDetectResources: false` отключает стандартный OTel `envDetector` — который обычно читает `OTEL_RESOURCE_ATTRIBUTES` и `OTEL_SERVICE_NAME` environment variables. Это имеет причину (detector async, триггерит `diag.error` до settle), но побочный эффект в том что эти стандартные environment variables в nessy-cli **полностью не работают**.

### 2.2 `session.id` фактически тройная инъекция

| Позиция                   | Строка                   | Влияние                               |
| ------------------------- | ------------------------ | ------------------------------------- |
| Resource                  | `sdk.ts:160`             | все signal (spans / logs / metrics)   |
| Per-span                  | `session-tracing.ts:169` | spans                                 |
| Per-log                   | `loggers.ts:128`         | logs                                  |
| **`getCommonAttributes()`** | `metrics.ts:57`        | **явное добавление к каждой metric record** |

То есть **просто убрать `session.id` из Resource недостаточно** — `metrics.ts:57` `baseMetricDefinition.getCommonAttributes()` вызывается 30+ metric точками, снова добавляя `session.id` через `...spread`.

```ts
// metrics.ts:55-59
const baseMetricDefinition = {
  getCommonAttributes: (config: Config): Attributes => ({
    'session.id': config.getSessionId(),
  }),
};
```

Хорошая новость: все metric вызовы (30+) идут через эту одну функцию, это естественная chokepoint.

### 2.3 Паттерн config resolver

`packages/core/src/telemetry/config.ts:resolveTelemetrySettings()` использует единую priority chain:

```
argv (highest)  >  NESSY_* env  >  OTEL_* env  >  settings.json (lowest)
```

Новые элементы следуют этому паттерну.

### 2.4 Текущее состояние settings schema

`packages/cli/src/config/settingsSchema.ts:998-1018` определяет JSON schema для `telemetry`:

```ts
telemetry: {
  type: 'object',
  // ...
  jsonSchemaOverride: {
    type: 'object',
    properties: {
      includeSensitiveSpanAttributes: { ... },
    },
    additionalProperties: true,  // ← сегодня не валидирует другие telemetry.* key
  },
}
```

`additionalProperties: true` означает что сегодня schema пропускает все другие поля `otlpEndpoint` / `otlpProtocol` / `resourceAttributes` без валидации. При добавлении новых полей `resourceAttributes` / `metrics`, следует также добавить schema здесь для IDE autocomplete и settings UI rendering.

### 2.5 Код вне области этого дизайна

`packages/core/src/telemetry/nessy-logger/nessy-logger.ts` — это **first-party канал сбора использования** nessy-cli (на основе внутреннего протокола Alibaba RUM `RumResourceEvent`), полностью независим от OTel SDK. Имеет свой own endpoint, proxy и data model, **не затрагивается этим дизайном**. См. раздел 3.

## 3. Дизайн

### 3.1 Custom Resource Attributes

Добавить поддержку `telemetry.resourceAttributes` в settings:

```json
{
  "telemetry": {
    "resourceAttributes": {
      "team": "platform",
      "env": "production",
      "cost_center": "engineering"
    }
  }
}
```

Приоритет:

```
argv --resource-attribute  >  NESSY_RESOURCE_ATTRIBUTES  >  settings.json
```

### 3.2 Контроль кардинальности метрик

Добавить `telemetry.metrics.includeSessionId` (по умолчанию `false`):

```json
{
  "telemetry": {
    "metrics": {
      "includeSessionId": false
    }
  }
}
```

Когда `false`:
- `session.id` не добавляется в `getCommonAttributes()` для метрик
- `session.id` остаётся в spans и logs (для tracing и debugging)

### 3.3 Изменения кода

#### `sdk.ts`

```ts
const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  [SemanticResourceAttributes.SERVICE_VERSION]:
    config.getCliVersion() || 'unknown',
  // session.id больше не добавляется здесь для metrics
  ...config.getTelemetryResourceAttributes(), // Новые custom attributes
});
```

#### `metrics.ts`

```ts
const baseMetricDefinition = {
  getCommonAttributes: (config: Config): Attributes => {
    const attrs: Attributes = {};
    if (config.getTelemetryMetricsIncludeSessionId()) {
      attrs['session.id'] = config.getSessionId();
    }
    return attrs;
  },
};
```

#### `config.ts`

Добавить новые методы:

```ts
getTelemetryResourceAttributes(): Record<string, string>;
getTelemetryMetricsIncludeSessionId(): boolean;
```

#### `settingsSchema.ts`

Добавить JSON schema для новых полей.

## 4. Преимущества

1. **Гибкость**: operations может добавлять любые custom атрибуты.
2. **Контроль кардинальности**: `session.id` опционален для метрик.
3. **Совместимость**: стандартные `OTEL_*` env vars работают через NESSY_* proxy.
4. **Безопасность**: sensitive данные не попадают в telemetry без явного указания.

## 5. Риски

1. **High-cardinality атрибуты**: пользователи могут добавить `user_id` или `session.id` в resource attributes, что приведёт к explosion метрик. Документировать best practices.
2. **Миграция**: существующие dashboards могут зависеть от `session.id` в метриках. Требуется migration guide.

## 6. Тестирование

1. Unit тесты на `getTelemetryResourceAttributes()` и `getTelemetryMetricsIncludeSessionId()`.
2. Integration тесты на OTLP export с custom attributes.
3. E2E тесты на cardinality control.
