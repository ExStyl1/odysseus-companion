---
name: "tbank-performance-review"
description: "Сбор подтверждений результатов сотрудника за период из корпоративных систем в пакет RESULTS.md."
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

---


# Сбор результатов для Performance Review

Весь диалог с пользователем веди на русском. Исходные identifiers, product names и raw-ответы не переводи.

## Входной gate — выполнить до любых tools

Для запуска нужны:

```text
employee: корпоративный login; ФИО необязательно
period: квартал, год или произвольный диапазон
systems: выбранное подмножество Jira, Tracker, GitLab, Wiki, Time
goals: приоритетные задачи, что планировалось и какой результат ожидался
time_channels: точный allowlist URL/names, если выбран Time
```

Если скилл вызван без этих данных, твоё единственное действие в этом ходе — вывести обычным текстом следующий запрос и завершить ответ:

```text
Пришлите, пожалуйста, одним сообщением:

1. Корпоративный логин сотрудника и, если нужно, ФИО.
2. Период: квартал, год или точные даты.
3. Системы для проверки: Jira, Tracker, GitLab, Wiki, Time.
4. Приоритетные цели и задачи: что планировалось и какой результат ожидался.
5. Если выбран Time — точные ссылки или названия разрешённых каналов.
```

На этом ходе не вызывай `AskUserQuestion`, не читай references, README или demo-файлы, не просматривай каталог и не запускай другие tools. Если часть данных уже дана, тем же обычным текстом запроси только недостающие поля и заверши ответ.

Цели — обязательный gate. Исключение: пользователь явно написал, что хочет discovery без заранее заданных целей. Фраза `нет seeds` сама по себе таким разрешением не является.

Квартал или год преобразуй в абсолютный период ревью `[start, end)` самостоятельно; верхняя граница — первый день следующего периода. Затем без дополнительного вопроса вычисли окно поиска `[start - 14 дней, end + 14 дней)`. Например, для Q1 2026 период ревью — `[2026-01-01, 2026-04-01)`, окно поиска — `[2025-12-18, 2026-04-15)`.

Расширенное окно нужно только для обнаружения пограничных задач и доказательств. Оно не расширяет сам период ревью и не позволяет автоматически засчитывать в него результат, достигнутый раньше или позже.

Только когда весь входной gate закрыт, прочитай [references/collection-workflow.md](references/collection-workflow.md) и выполни описанный там сбор. Результат collector должен быть самодостаточным: `tbank-performance-writer` может использовать его без чтения `raw/`, но работа collector не зависит от наличия или запуска writer.
