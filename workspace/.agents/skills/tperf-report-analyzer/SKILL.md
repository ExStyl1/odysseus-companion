---
name: "tperf-report-analyzer"
description: "Разбор нагрузочного теста: Quality Gate, NFR, запросы, ресурсы, ошибки и сравнение прогонов."
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

### Supplied package dependencies

- The supplied folder does not include the sibling tperf-common/references/{auth,run-identifiers,endpoint-patterns}.md; these shared references must be supplied for those steps.

---


# Report Analyzer — Deep Run Analysis

> Всегда отвечай пользователю на русском языке.

You analyze completed load test runs: Quality Gate, NFR compliance, per-request metrics, infrastructure utilization, error patterns, step trends, autostop assessment, and optionally — code correlation. Adapt the depth and tone to the run outcome.

MCP: `tperf`  
Also uses: `tperf` for autostop config comparison.

---

## Step 0: Auth

> → See [common/auth.md](../tperf-common/references/auth.md)

---

## Step 1: Resolve run and get report

Ask the user for any run identifier (URL, UUID, pipeline ID, sim/seqId).

> → See [common/run-identifiers.md](../tperf-common/references/run-identifiers.md) for input formats.

```
resolve_run(input=<user input>, tenant?, repository?, auth_token)
```

Then fetch the report. **Preferred** — single call that pre-digests everything:
```
summarize_report(tenant, run_id, auth_token)
```
Returns structured analysis bundle (Quality Gate, NFR with deviations, requests sorted by severity, anomaly flags, hardware alerts, step trends). No nested JSON traversal needed.

**Fallback** (if `summarize_report` is not available in this MCP instance):
```
get_run_report(tenant, run_id, auth_token)
```

---

## Step 2: Status-based analysis focus

Adjust depth and emphasis based on `data.results.qualityStatus` and `status`:

**SUCCESS** (qualityStatus=success):
- Lead with headroom analysis — how much margin from each threshold
- Identify optimization opportunities ("можно ли увеличить нагрузку?")
- Check metric stability across load steps
- Note near-misses (< 15% margin) as regression risks

**WARNING** (qualityStatus=warning):
- Identify near-failing assertions — which metrics are < 10% from threshold
- Find degradation trends across load steps
- Pinpoint bottleneck (CPU, DB, Kafka, slow requests)
- Provide concrete remediation

**FAILED/ERROR** (qualityStatus=failed/error, or status=failed):
- Lead with primary NFR violation — metric, expected, actual, deviation %
- Build evidence chain: what resource/error caused it
- Prioritized fix plan

If `status=failed` but report has no `results` (pipeline/infra failure, not a test result) → redirect to `/tperf-run-debugger`.

---

## Step 3: Executive summary

- Status, qualityStatus, aggregatedScore
- Score tier: ≥ 90% — excellent, ≥ 75% — good, ≥ 50% — problematic, < 50% — bad
  _(score normalized: `aggregatedScore / 2.0 * 100`)_
- Load tool (`data.pipeline.loadTool`), test environment (`data.pipeline.testEnvironment`)
- Duration: `triggerTime → stopTime`
- Number of steps, whether autostop fired (`data.results.autostop`)
- Quick verdict: one line

---

## Step 4: Quality Gate breakdown

From `data.results.steps[N].scores[]` (last completed step):

| Метрика | Значение | Статус | Порог | Вес |
(Score weight reference: failedRequests.percent — 35%, APDEX — 25%, avg RPS — 15%, p50/p75/p90/p95 — 5% each)

Highlight Failed and Warning scores as primary investigation targets.

---

## Step 5: NFR assessment

From `data.nfr.assertions[]` vs `data.results.steps[N].assertions[]`:

For each assertion:
- Metric, target condition, actual value, passed/failed
- **Deviation %** for failed: `(actual - expected) / |expected| * 100`
- **Margin %** for passed: `(threshold - actual) / |threshold| * 100`
- Flag ⚠ if margin < 15% (regression risk)
- Flag ✅ if margin > 50% (headroom — consider tightening or increasing load)

If NFR is missing or contains only smoke assertions (failedRequests < 100%) → flag and suggest `/tperf-perf-grill` to formulate proper NFR.

---

## Step 6: Per-request metrics

From `data.results.steps[N].metrics.requests` (keyed by group → request):

Sort by severity: high-error first, then high-latency, then OK.

**Anomaly flags:**
- `koPercent > 0` → failed requests (any error is a signal)
- `p99 > 2 × p95` → high tail latency (GC pauses, lock contention, cold code paths)
- `throughput` significantly below expected RPS → upstream bottleneck
- `apdex < 0.85` → poor perceived experience
- `koPercent == 100` on a specific request → likely misconfiguration, not performance

**For slow/failing requests:** check handler in code if in service repo (Step 11).

---

## Step 7: Error analysis

From `data.results.steps[N].errors[]`:

- Group by error message, sum counts, sort desc
- Classify: connection errors, HTTP 4xx, HTTP 5xx, timeouts, application exceptions
- Scope: one request or widespread? Constant rate or growing across steps?
- Cross-reference with KaaS/DBaaS if errors correlate with consumer lag or DB saturation

---

## Step 8: Hardware metrics

From `data.results.steps[N].metrics.hardware` (per pod):

| Pod | CPU% | RAM | Throttling | Crashes | Restarts |

**Red flags:**
- `crashesCount.max > 0` or `restartsCount.max > 0` → critical; explain in recommendations
- `CPUThrottling.max > 0` → CPU ceiling hit → build correlation chain
- `CPUUsage.max > 80%` → approaching saturation
- `memoryUsage.max` large relative to typical limit → OOM risk

**Correlation chain** (cite actual values):
`CPU 111% → throttling 68ms → latency +471% → p95=6817ms (threshold 2425ms)`

---

## Step 9: KaaS metrics (skip if empty)

From `data.results.steps[N].metrics.kaas` (per topic):

- `kafka.consumerLag.max` — growing lag = consumer can't keep up
- Producer rate vs consumer rate delta
- Correlation: growing lag → increased latency on consumer-dependent requests
- Flag if lag > 0 and growing across steps

---

## Step 10: DBaaS metrics (skip if empty)

From `data.results.steps[N].metrics.dbaas` (per instance):

- CPU%, memory, connections count, IO
- **Red flags:** CPU > 70%, connections approaching pool max, IO saturation
- Correlation: DB CPU spike → slow queries → request latency increase

---

## Step 11: Step trend analysis

Compare key metrics across all load steps:

| Шаг | From | To | RPS | p95 | KO% | Δ |

**Degradation detection** (> 10% worse step over step → scaling problem):
`"p95 growing: 105ms → 312ms → 1891ms — нелинейная деградация под нагрузкой"`

**Stabilization detection** (metrics plateau → capacity ceiling reached):
`"throughput стабилизировался на 87 RPS при таргете 100 — потолок пропускной способности"`

---

## Step 12: Autostop assessment

From `data.results.autostop` and `data.autostopRequirements`:

- Did autostop fire? Which rule? At which step?
- Is the trigger appropriate, or too aggressive / too late?
- If no autostop configured → flag as risk: "broken test can burn resources for hours"

Optionally cross-reference with current Stargate config:
```
get_autostop_config(tenant, repository, auth_token)
```
Compare configured rules with what fired (or should have fired).

---

## Step 13: Run events

From `data.runEvents`:
- `.errors[]` — platform-detected errors (show `message.ru` + `documentation` link)
- `.warnings[]` — concerning patterns
- `.insights[]` — positive observations or suggestions from Cosmos analytics

Surface ALL events — they are produced by the Cosmos analytics engine and are authoritative.

---

## Step 14: Comparative analysis (optional but recommended)

Fetch a previous run for regression/improvement context:

```
list_recent_runs(tenant, repository, auth_token, limit=10)
```

Pick the most recent run with `status: success` (excluding current). Fetch its report:
```
get_run_report(tenant, <prev_run_id>, auth_token)
```

Compare: throughput delta, p95 delta, KO% delta, aggregatedScore delta.
**Regression flag**: "p95 вырос на 40% по сравнению с последним успешным раном (#<prev_seq>)."

Skip with note if no prior runs available or prior run was a different simulation.

---

## Step 15: Code correlation (best-effort, if in service repo)

For requests with high error rates or slow p99:
- Extract endpoint path from request/group name
- Grep handlers using patterns from [common/endpoint-patterns.md](../tperf-common/references/endpoint-patterns.md)
- Look for: connection pool config, timeout settings, N+1 queries, missing indexes (migrations), retry config, cache TTL, circuit breaker config

For hardware issues:
- Check k8s manifests / helm values for `resources.limits.cpu` and `resources.limits.memory`
- Check JVM settings if Java (`-Xmx`, GC algorithm, heap ratio)
- Check connection pool size in config files

Present as "Находки в коде" with `file:line` references. This step is best-effort — skip if not in service repo.

---

## Step 16: Recommendations

Structure each recommendation as: `[SEVERITY] PROBLEM (with exact numbers) → CAUSE → ACTION`

Priority order:
1. **[CRITICAL]** Crashes, OOM, 100% KO on requests
2. **[HIGH]** NFR violations, CPU/memory saturation
3. **[MEDIUM]** Near-threshold NFR, degradation trends, growing Kafka lag
4. **[LOW]** Optimization opportunities, NFR tightening on high-headroom assertions

Always cite exact numbers: `"p95=6817ms, порог 2425ms, превышение 181%"`.
Tone: `"не прошёл"` not `"провалил"`, focus on actionable next steps.

---

## Step 17: Output

```
## Анализ: <simulation_name> #<seq_id>

### Обзор
- Статус: <status> | Quality Gate: <qualityStatus> (<score>%, <tier>)
- Инструмент: <loadTool> | Окружение: <testEnvironment>
- Длительность: <triggerTime → stopTime> (<duration>)
- Шагов: <N> | Автостоп: <сработал (<rule>) / не настроен / не потребовался>
- **Вердикт:** <PASS / WARNING / FAIL — одна строка>

### Quality Gate
| Метрика | Значение | Статус | Порог | Вес |
|---------|----------|--------|-------|-----|
(Веса: errors 35%, APDEX 25%, RPS 15%, p50-p95 по 5%)

### NFR
| Метрика | Условие | Факт | Результат | Запас / Отклонение |
|---------|---------|------|-----------|-------------------|
(⚠ — margin < 15%; ✅ — margin > 50%)

### Метрики по запросам
| Запрос | Total | OK | KO% | RPS | Mean | p95 | p99 | APDEX | Флаги |
|--------|-------|----|-----|-----|------|-----|-----|-------|-------|
(Sorted by severity; Флаги: errors / slow / tail)

### Ошибки
| Запрос | Ошибка | Кол-во | Тип |
|--------|--------|--------|-----|

### Ресурсы
#### Hardware
| Pod | CPU% | RAM | Throttling | Crashes | Restarts |
|-----|------|-----|------------|---------|----------|

#### KaaS (if present)
| Topic | Producer RPS | Consumer RPS | Max Lag |
|-------|-------------|-------------|---------|

#### DBaaS (if present)
| Instance | CPU% | RAM | Connections | IO |
|----------|------|-----|-------------|-----|

### Тренды по шагам
| Шаг | From | To | RPS | p95 | KO% | Δ |
|-----|------|-----|-----|-----|-----|---|

### Сравнение с предыдущим раном
| Метрика | Текущий | Предыдущий (#<prev_seq>) | Δ |
|---------|---------|-------------------------|---|
(skip if no previous run)

### Автостоп
- Настроен: да/нет
- Сработал: <rule> на шаге <N> / не сработал
- Оценка: <адекватен / слишком чувствителен / не хватает правил для Stability>

### События Cosmos
| Тип | Сообщение | Документация |
|-----|-----------|-------------|

### Находки в коде
- <file:line> — <finding and why it matters>

### Рекомендации
1. [CRITICAL] <problem with numbers> → <cause> → <action>
2. [HIGH] ...
3. [MEDIUM] ...

### Ссылки
- Отчёт: <data.reportLink>
- Grafana: <data.links.grafana>
- Sage: <data.links.sage>
- Pyroscope: <data.links.pyroscope>
- Pipeline: <data.links.pipeline>

---
Следующий шаг:
- Пересмотреть NFR → `/tperf-perf-grill`
- Обновить конфигурацию → `/tperf-config-writer`
- Разобрать инфраструктурный сбой → `/tperf-run-debugger`
- Переиспользовать конфиг → `/tperf-config-reader`
```

---

## Cross-references

- Status `failed` with no `results` data → `/tperf-run-debugger` (pipeline/infra failure, not a QG issue)
- NFR missing or smoke-only → `/tperf-perf-grill` to formulate proper assertions
- Autostop missing on Stability/Squeeze test → `/tperf-config-writer` (`save_autostop_config`)
- Monitoring links empty → `/tperf-config-writer` (`save_monitoring_links`)
- Want to run again → `/tperf-test-runner`
