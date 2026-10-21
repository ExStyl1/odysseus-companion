# Documentation structure

The canonical structure below is based on Diátaxis and arc42. It is a **target reference**. The actual layout in the repo is the source of truth: if a structure is already established, follow it and treat this schema as guidance on intent.

## Tier-0 — minimum required from day one

```
<repo>/
├── README.md              Service business card: 1–2 paragraphs, link to docs portal, quickstart
└── docs/
    ├── index.md           Service passport (2–3 min read): purpose, ownership, stack,
    │                      criticality, SLO, section links. Max 1–2 screens.
    ├── architecture/
    │   └── overview.md    C4 Container/Component, key patterns, upstream/downstream
    ├── domain/
    │   └── business-logic.md  Glossary, key entities, lifecycles, business rules, invariants
    └── development/
        └── quickstart.md  Local setup in 15–30 minutes
```

## Extended layout — as the service grows

```
<repo>/
├── README.md                     Business card, badges, quickstart
├── CONTRIBUTING.md               Repo workflow rules
└── docs/
    ├── index.md                  Service passport
    │
    ├── architecture/             HOW it is built
    │   ├── overview/             C4, tech stack, key patterns
    │   ├── data-flow/            Sequence diagrams of key scenarios
    │   ├── integrations/         External deps, contracts, degradation
    │   └── adr/                  Architecture Decision Records (one file per decision)
    │
    ├── domain/                   WHAT and WHY (business meaning)
    │   ├── overview.md           Domain map (when 2+ domains)
    │   ├── cross-domain-flows/   Processes spanning multiple domains
    │   └── <domain-name>/        One directory per domain
    │       ├── index.md          Domain overview: entities, glossary, links
    │       └── <feature>.md      Feature page: flow, rules, statuses
    │
    ├── interfaces/               Public contracts (prefer auto-generation)
    │   ├── rest/                 OpenAPI + consumers, auth, rate limits
    │   ├── grpc/                 .proto + consumers, timeouts, retries
    │   ├── async/                Kafka / RabbitMQ: publish / consume, schemas, guarantees
    │   └── cache/                Redis / in-memory: keys, TTL, invalidation
    │
    ├── schemas/                  Data schemas
    │   ├── database.md           Tables, ER, partitioning
    │   └── clickhouse.md         Analytics store
    │
    ├── operations/               Operations
    │   ├── configuration.md      Env vars, feature flags, secrets (names + locations)
    │   ├── monitoring.md         Dashboards, key metrics, alert links
    │
    └── development/              For developers and QA
        ├── quickstart.md         Local setup
        ├── testing.md            Test strategy
        └── how-to/               Service-specific recipes
```

## Placement rules — "what changed → what to update"

| What changed                       | Where to update                                                                  |
|------------------------------------|----------------------------------------------------------------------------------|
| New business feature               | Create `domain/<domain>/<feature>.md`, update `domain/<domain>/index.md`         |
| New REST endpoint                  | Update `interfaces/rest/` (consumers table)                                      |
| New cache (Redis / in-memory)      | Update `interfaces/cache/`                                                       |
| New Kafka topic                    | Update `interfaces/async/`                                                       |
| New config property                | Update `operations/configuration.md`                                             |
| Significant architectural decision | Add an ADR in `architecture/adr/`                                                |

## Proximity to code

Documentation that changes together with code must live next to the code and be reviewed in the same MR. Cross-service standards, conventions, and aggregated materials live in a separate aggregator repository.

## File format

### Frontmatter

Every file under `docs/` starts with frontmatter when the docs portal supports a sidebar. Root `README.md` does not use portal frontmatter:

```yaml
---
title: "Заголовок страницы"
sidebar_label: Короткое имя
sidebar_position: 1
---
```

* `sidebar_position: 0` for `index.md`.
* Detail pages start at `1`.

### Formatting and technical markers

Anchors on `##`/`###`, exact code types (`Long`, `BigDecimal`, `UUID` — never «число»/«дата»), backticks for technical names, and grep-ability of job/topic/endpoint names are owned by `references/editorial-policy.md`. Consult it before writing.

### Service passport (`docs/index.md`)

Must fit into 2–3 minutes of reading and contain:

* **Назначение** — what business problem the service solves.
* **Владение** — team and contact channel.
* **Стек** — language, framework, DB, broker.
* **Критичность и SLO** — tier, business hours, link to monitoring.
* **Что делает** — 3–5 bullets.
* **Навигация по разделам** — links to main sub-pages.

Rule: max 1–2 screens. Details belong in their dedicated sections.

## Document formatting rules — team standard {#formatting-rules}

These four rules come from the team's documentation RFC. They are the standard for any backend service's `docs/`, and they exist mainly to keep RAG search accurate. Apply them on every page.

### 1. Meaningful file and directory names {#meaningful-names}

* A file name is a short answer to the question a human or an agent would ask.
* The full path (directories included) is part of the document's meaning — RAG indexes it as metadata.
* Directory names are common, understandable English: `architecture/`, `operations/`, `development/`, `domain/`.
* No abbreviations or contractions: not `ops/`, `rb/`, `arch/`.
* Separate words in file names with hyphens.

`architecture/data-flow/order-confirmation.md` carries more context than `arch/df/oc.md`.

### 2. Section title page {#section-title-page}

An extended section with several pages needs a title page. Two acceptable options:

* a file named after the section/directory — `architecture/architecture.md`, `operations/operations.md`;
* or a `_category_.yml` with `link: { type: 'doc', id: '...' }`.

Avoid `index.md` for a section title page — it is the obvious default, but it confuses RAG during indexing. Exception: the root `docs/index.md` (the service passport). When a section already uses `index.md`, match the existing convention instead of renaming everything — apply the section-named pattern to brand-new sections.

### 3. One file, one topic {#one-file-one-topic}

* Each document closes one question or one coherent topic.
* Target size: 50–400 lines.
* Under 50 lines → fold into an established neighboring document when one exists. For a new Tier-0 tree, keep an evidence-limited page concise instead of padding it.
* Over 400 lines → almost always several topics, split them.

### 4. Context header in every document {#context-header}

Start every file with a title that answers the document's question, then 1–2 sentences on what it covers and for whom:

```markdown
# <Topic — answers the document's question>

<1–2 sentences: what the document is about and who will find it useful>
```

A human immediately sees whether they are in the right place, and RAG takes the first chunk of the document — so the essence lands in the index and answer relevance improves.
