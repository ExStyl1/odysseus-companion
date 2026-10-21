---
name: "mermaid-diagrams"
description: "Практическое руководство по созданию читаемых человеком и разбираемых агентом диаграмм используя Mermaid. Включает консервативные, совместимые с рендерерами шаблоны и руководство когда что использовать."
---

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


# Mermaid Diagrams Skill

## Правила совместимости (Прочитать сначала)
- Предпочитать `graph LR`/`graph TB` для блок-схем; некоторые рендереры падают на ключевом слове `flowchart`.
- Цитировать метки содержащие пробелы/спецсимволы: `A["Text (x|y) |"]`.
- **Не использовать буквальный `\n` внутри меток** — Mermaid не интерпретирует такие разрывы строк. Использовать `<br/>` для разрывов строк.
- Продвинутые типы как `quadrantChart`, `sankey-beta`, `requirementDiagram`, `gitGraph` могут быть недоступны. Использовать предоставленные fallback блок-схем.
- Code fences должны начинаться с колонки 0 с языком `mermaid`.

## ASCII/Unicode Sidecar (Читаемый человеком Raw Markdown)
Для оптимизации для быстрого человеческого сканирования в raw Markdown и надежного разбора агентом, всегда поставлять ASCII/Unicode sidecar сразу под каждым блоком Mermaid.

Политика:
- MUST включать моноширинную, текстовую диаграмму сразу под блоком Mermaid используя fenced code с языком `text`.
- MUST держать Mermaid и sidecar в синхронизации (те же узлы/ребра, те же метки где возможно). Если расходятся, трактовать Mermaid как источник истины и обновить sidecar.
- SHOULD ограничить ширину до ~80 колонок для читаемости в diffs и терминалах.
- SHOULD использовать простые символы линейной графики (ASCII сначала; Unicode box-drawing опционально когда среда поддерживает).
- MAY добавить однострочную подпись над парой: `Diagram: <имя> (<тип>)`.

Рекомендуемые примитивы:
- Коробки: `[Name]`, `(Name)`, `+-----+\n| N |\n+-----+`
- Потоки: `-->`, решения как `{cond?}` линии, списки с `-`.
- Sequence (text-based): `Actor -> Actor: message` с отступами lifelines.

Пример (Flowchart):
```mermaid
graph LR
  A["Start"] --> B{Auth?}
  B -->|Yes| C["Dashboard"]
  B -->|No|  D["Login"]
```
```text
Diagram: Auth flow (flowchart)
  [Start] --> {Auth?}
      {Auth?} -- Yes --> [Dashboard]
      {Auth?} -- No  --> [Login]
```

Пример (Text-based Sequence):
```mermaid
sequenceDiagram
  participant U as User
  participant W as WebApp
  U->>W: Open
  W-->>U: OK
```
```text
Diagram: Happy path (sequence)
  User -> WebApp : Open
  WebApp -> User : OK
```

## Рабочие шаблоны (Совместимые с рендерером)

### Flowchart
```mermaid
graph LR
  A["Start"] --> B{Auth?}
  B -->|Yes| C["Dashboard"]
  B -->|No|  D["Login"]
  C --> E["Settings"]
```

### Sequence
```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as WebApp
  participant API
  U->>W: Open
  W->>API: GET /status
  API-->>W: 200
  W-->>U: OK
```

### Class
```mermaid
classDiagram
  class User {
    +String id
    +String name
    +login(): bool
  }
  class Order {
    +String id
    +Decimal total
    +submit()
  }
  User "1" o-- "*" Order
```

### State (v2)
```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Loading : fetch
  Loading --> Ready : ok
  Loading --> Error : fail
  state Ready {
    [*] --> Viewing
    Viewing --> Editing : edit
    Editing --> Viewing : save
  }
  Error --> Idle : retry
```

### ER (Entity-Relationship)
```mermaid
erDiagram
  USER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_LINE : contains
  PRODUCT ||--o{ ORDER_LINE : referenced
  USER {
    string id
    string email
  }
  PRODUCT {
    string id
    string name
    float price
  }
```

### Journey (User Journey)
```mermaid
journey
  title Checkout UX
  section Browse
    "See product": 5: User
    "Add to cart": 4: User
  section Payment
    "Enter card": 2: User
    "3DS confirm": 2: User
  section Result
    "Success page": 5: User
```

### Gantt
```mermaid
gantt
  title Release Plan
  dateFormat  YYYY-MM-DD
  section Dev
  Spec  :done,   des1, 2025-10-01,2025-10-05
  Impl  :active, des2, 2025-10-06,2025-10-20
  Tests :        des3, 2025-10-21, 7d
  section Release
  Freeze :milestone, m1, 2025-10-28, 0d
  Deploy :crit,    des4, 2025-10-29, 1d
```

### Pie (совместимый синтаксис)
```mermaid
pie
  title Traffic by Source
  "Direct"  : 35
  "Organic" : 45
  "Ads"     : 20
```

### Quadrant — flowchart fallback
```mermaid
graph TB
  Q1["Quick Wins<br/>High Impact - Low Effort<br/><br/>- Improve UX"]
  Q2["Major Projects<br/>High Impact - High Effort<br/><br/>- Rewrite Core"]
  Q3["Fill-ins<br/>Low Impact - Low Effort<br/><br/>- Docs polish"]
  Q4["Thankless<br/>Low Impact - High Effort<br/><br/>- Legacy migration"]

  Q1 --> Q2
  Q1 --> Q3
  Q2 --> Q4
  Q3 --> Q4
```

### Requirement — flowchart fallback
```mermaid
graph LR
  R1["Requirement: PCI-DSS compliant"]
  T1["Test: PCI checklist"]
  SVC["Service"]

  SVC -- satisfies --> R1
  T1  -- verifies  --> R1
```

### Sankey — flowchart fallback (веса на ребрах)
```mermaid
graph LR
  Checkout["Checkout"] -->|100| PSP["PSP"]
  PSP -->|60|  Settled["Settled"]
  PSP -->|40|  Declined["Declined"]
```

### Git graph — flowchart fallback (простой DAG)
```mermaid
graph LR
  A["init"] --> B["feat-A"]
  A --> C["fix-1"]
  B --> D["merge"]
  C --> D
```

## Когда какую диаграмму использовать
- Flowchart: Общие потоки, решения, и движение данных в specs и PRDs.
- Sequence: Взаимодействия во времени между актерами/сервисами (API, запросы, ответы).
- Class: Модели предметной области и статическая структура; полезно для атрибутов сущностей и связей.
- State: Жизненный цикл сущности/компонента (idle -> loading -> ready/error, вложенные состояния).
- ER: База данных/логическая модель данных с кардинальностями.
- Journey: Пользовательский опыт через шаги/секции (отлично для PRD acceptance flows).
- Gantt: Планирование, релизы, и зависимости по датам.
- Pie: Простая композиция/отношения; предпочитать таблицы когда важна точность.
- Quadrant (fallback): Матрица приоритизации (Impact/Effort) без экспериментальной поддержки chart.
- Requirement (fallback): Трассируемость между требованиями, тестами, и элементами системы.
- Sankey (fallback): Относительные объемы вдоль пути когда `sankey` недоступен.
- Git graph (fallback): Маленькие branch/merge DAGs когда `gitGraph` недоступен.

## Troubleshooting
- Если диаграмма не рендерится, попробовать:
  1) Заменить `flowchart` на `graph` и упростить формы.
  2) Цитировать тексты узлов.
  3) Тестировать в `https://mermaid.live` для изоляции проблем среды.
  4) Fallback на шаблоны выше для максимальной совместимости.
