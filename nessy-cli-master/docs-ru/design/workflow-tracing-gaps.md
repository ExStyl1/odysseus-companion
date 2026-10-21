# Workflow-уровень: анализ недостаточной гранулярности Span (P1)

## Текущее состояние

nessy-cli уже имеет инфраструктуру tracing:

| Компонент       | Расположение                                       | Описание                                                     |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Определения Span | `packages/core/src/telemetry/session-tracing.ts` | `interaction`, `llm_request`, `tool`, `tool.execution`       |
| Инструменты Tracer | `packages/core/src/telemetry/tracer.ts`          | session root context, `withSpan`, `startSpanWithContext`     |
| Точки входа взаимодействия | `packages/core/src/core/client.ts`         | Топ-уровневое взаимодействие явно запускает `interaction` span |
| Управление жизненным циклом | —                                      | AsyncLocalStorage + WeakRef + TTL cleanup                    |

В текущем runtime стабильно подключены два типа generic spans:

- `api.generateContent` / `api.generateContentStream`
- `tool.<toolName>`

**Вывод: достигнута стадия «есть основная трассировка», но границы этапов agent workflow ещё не полностью закодированы в дерево trace.**

### Сравнение: claude-code реализованные типы span

Спрованкиа `claude-code/src/utils/telemetry/sessionTracing.ts` (line 49):

- `interaction`
- `llm_request`
- `tool`
- `tool.blocked_on_user`
- `tool.execution`
- `hook`

## Отсутствующие элементы

| Отсутствующий span / механизм          | Влияние                                            |
| -------------------------------------- | -------------------------------------------------- |
| `permission_wait` / `blocked_on_user` span | Невозможно различить ожидание утверждения vs время выполнения инструмента |
| `hook` span                            | Время hook сворачивается в tool span, границы размыты |
| `subagent` root span                   | Вызовы llm/tool внутри subagent не формируют поддерево trace |
| `tool.execution` реальное подключение   | helper определён, но в основном потоке не вызывается |
| Стабильная parent-child wiring         | spans в основном sibling под session root, а не иерархическое дерево |

## Постатейный анализ

### 1. Ожидание пользовательского утверждения не в trace

При вызове инструмента путь перехода состояния при ожидании утверждения: `awaiting_approval` → `scheduled` → выполнение.

- «Ожидание подтверждения пользователя» — только миграция состояния, не узел trace
- В trace не видно время ожидания утверждения
- При медленной работе инструмента невозможно различить «застревание в ожидании пользователя» или «инструмент сам выполняется медленно»

### 2. Hook имеет запись события, но нет отдельного span

Выполнение Pre/Post hook выдаёт `HookCallEvent`, идёт через `logHookCall()`, но не создаёт отдельный OTel span.

- Когда hook замедляется, это проявляется как замедление внешнего tool span
- При неудаче hook выглядит как «неудача tool»
- Trace не может ответить «время потрачено на hook или tool.execution»

### 3. Subagent не имеет root span

Когда agent порождает subagent (например, `/subagent` или internal delegation), внутренние вызовы llm/tool subagent не имеют общего root span.

- Можно статистически подсчитать «какой subagent запускался»
- В сценариях с параллельными subagent причинно-следственная связь неясна

### 4. `tool.execution` span определён, но не подключён

В `session-tracing.ts` уже есть `startToolExecutionSpan()` / `endToolExecutionSpan()`, но основной поток client.ts их не вызывает.

- Trace не может ответить «время потрачено на hook или tool.execution»
- Отсутствует явная граница между «подготовка аргументов» / «ожидание утверждения» / «фактическое выполнение»

## План исправления

### Краткосрочный (P1)

1. **Явный span ожидания утверждения**
   - Обернуть ожидание утверждения в span
   - Имя: `tool.blocked_on_user` или `permission_wait`
   - Атрибуты: `tool.name`, `permission_id`, `wait_duration_ms`

2. **Hook как отдельный span**
   - Pre/Post hook execution оборачивается в `hook.pre` / `hook.post`
   - Родитель: tool span
   - Атрибуты: `hook.name`, `hook.timing` (pre/post), `duration_ms`

3. **Subagent root span**
   - При создании subagent создавать `subagent` span
   - Внутренние llm/tool вызовы subagent имеют этот span как parent
   - Атрибуты: `subagent.id`, `subagent.goal`

4. **Подключение `tool.execution`**
   - Вызывать `startToolExecutionSpan()` перед фактическим выполнением tool
   - Завершать после `tool.call()` resolve
   - Явно отделять от hook / permission_wait

### Среднесрочный (P2)

- **Стабильная parent-child wiring**: обеспечить, чтобы spans формировали иерархическое дерево, а не sibling под session root
- **Автоматическое определение узких мест**: на основе длительности span определять «где время потеряно»

## Ожидаемый результат

После исправлений trace будет показывать:

```
interaction (12s)
├─ llm_request (1.2s)
└─ tool.write_file (10.5s)
   ├─ hook.pre (0.3s)
   ├─ permission_wait (8.0s) ← явно видно ожидание
   └─ tool.execution (2.2s) ← явно видно выполнение
      └─ subagent.code_review (1.8s)
         ├─ llm_request (1.5s)
         └─ tool.read_file (0.3s)
```

**Преимущества:**
- Возможность различить ожидание утверждения vs время выполнения инструмента
- Явная видимость накладных расходов hook
- Трассировка delegation через subagent
- Точное определение узких мест в workflow
