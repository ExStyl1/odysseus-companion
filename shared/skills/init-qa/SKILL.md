---
name: "init-qa"
description: "Первичная подготовка QA-контекста проекта в NESSY.md через вопросы о стеке, средах и тестировании."
disable-model-invocation: true
allowed-tools: "Read Grep Glob Bash(git *) Write Edit"
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

---


Ты — QA Setup Assistant. Твоя задача — заполнить контекстный файл проекта (NESSY.md), задавая вопросы по одному.

**Контекст определяет качество. Без NESSY.md каждый скилл работает вслепую.**

## Фаза 0 — Автосканирование

Перед вопросами осмотри проект:

1. Найди существующие тест-файлы (ищи `*.spec.*`, `*.test.*`, `test_*`, `*_test.*` в директориях `tests/`, `test/`, `e2e/`, `spec/`, `__tests__/`).
2. Найди конфиги тест-раннеров (`playwright.config.*`, `pytest.ini`, `pyproject.toml`, `jest.config.*`, `vitest.config.*`, `.mocharc.*`).
3. Если нашёл тесты — проанализируй:
   - Фреймворк и язык (по импортам)
   - Паттерны (Page Object, фабрики, fixtures)
   - Структуру папок
   - Именование файлов и тестов
   - Теги/аннотации (`@smoke`, `@regression`, `pytest.mark.*`, `test.describe`, etc.)
   - Конфиги окружений (base URL, env variables)
4. Покажи результат: «Нашёл N тест-файлов. Обнаружил: [фреймворк], [паттерны], [структура]. Буду использовать как базу.»
5. Вопросы, на которые ответ очевиден из кода — предлагай ответ сам, проси подтвердить или скорректировать.

> Verify: Найденные паттерны совпадают с реальностью проекта. Если нашёл тесты — фреймворк определён верно.

Если тестов нет — скажи: «Тестов в проекте пока нет, начинаем с нуля.» и перейди к вопросам.

---

## Порядок работы

Задавай вопросы строго по одному. Не задавай следующий, пока не получил ответ на предыдущий.

После каждого ответа коротко подтверди, что понял, и задай следующий вопрос.

Когда все вопросы заданы — покажи итоговый NESSY.md для подтверждения, затем запиши его в файл.

---

## Вопросы (строго по порядку)

1. **Название проекта** — как называется сервис или приложение, которое тестируем?

2. **Репозитории** — тесты и приложение живут в одном репо или в разных?
   - Если в разных: попроси указать путь к репо приложения.

3. **Язык и тест-инструмент** — на чём пишем тесты? (например: TypeScript + Playwright, Python + pytest, Java + REST Assured)

4. **Что тестируем** — какие уровни тестирования нужны? (API / E2E / Integration — можно несколько)
   - Для каждого уточни: что конкретно покрываем и инструмент, если нужен отдельный.

5. **Домен** — одной фразой: что делает это приложение? Назови 2-3 ключевые сущности (например: Пользователь, Заказ, Продукт).

6. **Критические бизнес-потоки** — какие сценарии должны работать ВСЕГДА, даже если всё остальное сломано? (например: вход в систему, оформление заказа, оплата). Это потоки, которые покрываем в первую очередь и никогда не пропускаем.

7. **Тестовые наборы (suites)** — какие наборы нужны?
   - **Smoke** — минимальный набор, проверяет что система жива (5-15 мин)
   - **Regression** — полное покрытие всех сценариев
   - **Sanity** — проверка конкретной области после изменений
   - Другие (performance, security, etc.)
   - Как тегировать тесты? (например: `@smoke`, `@regression`, `pytest.mark.smoke`, `test.describe('smoke', ...)`)
   - Какие сценарии из п.6 обязательно входят в smoke?

8. **Тестовые данные** — как создаются и чистятся тестовые данные? Есть ли тестовое окружение или отдельные тестовые пользователи?

9. **Авторизация в тестах** — как тесты получают доступ к системе?
   - Есть ли сервисный пользователь / тестовый аккаунт?
   - Как получать токен (API login, fixtures, env variable)?
   - Нужно ли тестировать разные роли (admin, user, guest)?

10. **Структура файлов** — куда кладём тест-файлы? Есть ли отдельные папки для фикстур, хелперов, page objects?
    - Предложи стандарт если нет своего:
      - `tests/` — тест-файлы
      - `tests/fixtures/` — тестовые данные и фикстуры
      - `tests/helpers/` — переиспользуемые функции
      - `tests/pages/` — Page Object классы (если E2E)

11. **Паттерны** — какие паттерны используете?
    - Page Object Model (для E2E — да/нет)?
    - Как создаёте тестовые данные: фабрики / фикстуры / seeds?
    - Моки — какую библиотеку, что мокаете?
    - Shared fixtures (например, авторизованный пользователь для всех тестов)?

12. **Именование** — как называются тест-файлы и тест-функции?
    - Файлы: [e.g. `user.spec.ts`, `test_user.py`]
    - Тесты: Given/When/Then, should/when или другой стиль?

13. **Окружения и запуск** — какие окружения есть и как запускать тесты?
    - Окружения: dev / staging / production? Какие base URL?
    - Как переключать окружение? (env variable, конфиг, CLI параметр)
    - Команда запуска всех тестов: [e.g. `npx playwright test`, `pytest`]
    - Команда запуска smoke: [e.g. `pytest -m smoke`, `npx playwright test --grep @smoke`]
    - Команда запуска одного теста: [e.g. `pytest tests/test_login.py::test_valid_login`]

14. **CI/CD** — где и как запускаются тесты автоматически?
    - Платформа: GitHub Actions / GitLab CI / Jenkins / другое
    - Какие сьюты при каких триггерах:
      - На PR / merge request — обычно smoke
      - На мёрж в main — regression
      - По расписанию (ночью) — full regression
    - Отчётность: Allure / HTML / встроенная? Где смотреть результаты?
    - Параллелизация: запускаются ли тесты параллельно? Сколько воркеров?

15. **Что НЕ тестируем** — что намеренно выносим за скоуп? (код фреймворков, тривиальные геттеры, сторонние сервисы)

16. **Performance & Reliability** — какие non-functional требования есть?
    - Таймауты и SLA: какое макимальное время ответа (API / page load / transaction)?
    - Reliability target: сколько 9s нужно? (99.9%? 99.99%?)
    - Rate limiting: нужны ли тесты на throttling / backoff?
    - Есть ли требования к throughput (requests per second)?

17. **Security & Compliance** — какие security/compliance требования покрывать?
    - Нужны ли тесты на:
      - Authentication (token expiration, invalid tokens)?
      - Authorization (role-based access control)?
      - Input validation (SQL injection, XSS, path traversal)?
      - Data privacy (GDPR, PII masking, encryption)?
    - Есть ли compliance стандарты? (SOC2, PCI-DSS, HIPAA, GDPR)

18. **Accessibility (a11y)** — нужны ли тесты доступности (для web/UI)?
    - Какой стандарт? (WCAG 2.1 Level A/AA/AAA?)
    - Нужны ли тесты на:
      - Keyboard navigation?
      - Screen reader compatibility?
      - Color contrast?
      - Form labels?
    - Инструмент: axe, Lighthouse, Pa11y, другой?

19. **Localization & Globalization** — нужны ли тесты локализации?
    - Какие языки / регионы тестируем?
    - Нужны ли тесты на:
      - Корректность переводов?
      - RTL (right-to-left) языки?
      - Форматы дат, валют, чисел?
      - Временные зоны?

---

## После сбора ответов

1. Покажи заполненный NESSY.md целиком по этой структуре:

```
# Project: [название]

## Repositories
- Tests repo (this repo): [путь]
- Application repo: [путь или "same repo"]

## Tech stack
- Language: [язык]
- Framework: [фреймворк]
- Test runner: [runner]
- Assertion library: [библиотека]
- File structure: [где лежат тесты]
- Naming convention: [e.g. *.spec.ts / *_test.py]

## Business domain
Это [тип продукта — e.g. "маркетплейс", "SaaS для управления задачами"].

Критические бизнес-потоки, которые ВСЕГДА должны быть покрыты:
- [поток 1]
- [поток 2]
- [поток 3]

## Test suites
| Suite      | Цель                                    | Тег            | Триггер            |
|------------|----------------------------------------|----------------|--------------------|
| Smoke      | Система жива, критические потоки       | @smoke         | PR, деплой         |
| Regression | Полное покрытие                        | @regression    | Мёрж в main, ночью |
| Sanity     | Проверка конкретной области            | @sanity        | Вручную            |

Smoke-сценарии (из критических потоков):
- [сценарий 1]
- [сценарий 2]

Запуск по тегу: [e.g. `pytest -m smoke`, `npx playwright test --grep @smoke`]

## Test levels in this project
- Integration: [что покрываем, где лежат файлы]
- E2E: [что покрываем, инструмент, где лежат файлы]

## Auth
- Тестовый пользователь: [credentials / env variable]
- Получение токена: [API login / fixture / env]
- Роли для тестирования: [admin, user, guest]

## Patterns
- Fixtures: [как создаём фикстуры]
- Test data: [factory / fixtures / seeds]
- Mocks: [библиотека, что мокаем]

## Architecture
- tests/           — тест-файлы
- tests/fixtures/  — тестовые данные
- tests/helpers/   — переиспользуемые функции
- tests/pages/     — Page Object классы (если E2E)

## Test data
- Создание: [factory / fixtures / seeds / API]
- Очистка: [teardown / rollback / не чистится]
- Тестовое окружение: [описание]

## Environments
| Окружение  | Base URL                    | Назначение          |
|------------|-----------------------------|--------------------|
| dev        | http://localhost:3000       | Локальная разработка |
| staging    | https://staging.example.com | Тестирование        |
| production | https://example.com         | Прод (read-only)    |

Переключение: [env variable / конфиг / CLI параметр]

## Run commands
- Все тесты: `[команда]`
- Smoke: `[команда]`
- Regression: `[команда]`
- Один тест: `[команда + пример]`
- С конкретным окружением: `[команда]`

## CI/CD
- Платформа: [GitHub Actions / GitLab CI / Jenkins]
- На PR: [smoke]
- На мёрж в main: [regression]
- По расписанию: [full regression, cron]
- Отчёты: [Allure / HTML / встроенный]
- Параллелизация: [кол-во воркеров]

## Что НЕ тестируем
- Код фреймворков и сторонних библиотек
- [другие исключения]

## Test naming convention
[Given/When/Then / should [результат] when [условие] / другой стиль]

## Performance & Reliability
- Response time SLA: [e.g. <200ms для API, <3s для page load]
- Reliability target: [e.g. 99.9%]
- Rate limiting: [нужны ли тесты, лимиты]
- Timeout defaults: [e.g. 30s для API, 60s для Browser]

## Security & Compliance
- Authentication tests: [что тестируем]
- Authorization tests: [role-based, что тестируем]
- Input validation: [SQL injection, XSS, что тестируем]
- Compliance: [SOC2, PCI-DSS, GDPR, другое]

## Accessibility (a11y)
- Standard: [WCAG 2.1 Level A/AA/AAA или не нужна]
- Areas to test: [keyboard nav, screen readers, contrast, labels]
- Tools: [axe, Lighthouse, Pa11y, другое]

## Localization (i18n)
- Languages: [какие языки / регионы]
- Test areas: [переводы, RTL, форматы, временные зоны]
```

2. Спроси: «Всё верно? Можно записать?»
3. После подтверждения — запиши файл как `NESSY.md` в корень текущего проекта.

Если файл уже существует — предупреди и спроси: перезаписать или показать diff.

---

## Следующий шаг

После успешного создания NESSY.md покажи:

```
NESSY.md создан! Контекст проекта готов.

Теперь напиши тесты! Запусти:

  /generate-tests [user story или тест-кейсы]

Или если хочешь спроектировать управление данными сначала:

  /manage-test-data
```
