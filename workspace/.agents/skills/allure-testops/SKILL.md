---
name: "allure-testops"
description: "Поиск и резервирование Allure TestOps ID через Spirit CLI с добавлением @AllureId в тесты."
trigger: ["Добавить или создать @AllureId","Зарегистрировать автотест в Allure TestOps","Создать Kotlin или Java-тест рядом с тестами, использующими @AllureId","Найти тесты без @AllureId в проекте с принятой Allure-разметкой"]
when: ["Новый или изменённый тест должен соответствовать принятой в проекте Allure-разметке","Нужно найти Allure-проект и проверить существующий тест-кейс","Нужно безопасно зарезервировать ID без создания дубля"]
tags: ["allure","allure-testops","testing","kotlin","java","test-management","annotation"]
disable-model-invocation: true
user-invocable: true
when_to_use: "По явному запросу на поиск или резервирование Allure ID и разметку тестов."
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


# Allure TestOps

Находи проект, исключай дубли, резервируй недостающие ID через `dp allure` и точечно
добавляй аннотации локальным скриптом. Не используй прямой REST API и не работай с токеном.

## Когда применять автоматически

Применяй skill без отдельного упоминания Allure, когда одновременно выполняются условия:

- задача включает создание или изменение Kotlin/Java-теста;
- в том же файле, классе, пакете или test suite соседние тесты используют `@AllureId`;
- у нового или изменённого теста ID отсутствует.

Наличие `@AllureId` где-то в репозитории само по себе не разрешает менять Allure или код.
При read-only ревью только сообщи об отсутствующем ID.

## Scope

Обрабатывай только новые или изменённые тесты из текущей задачи. Не сканируй весь
репозиторий, если пользователь попросил добавить один тест.

## 1. Найди тесты

Разреши путь к директории этого skill и используй локальный read-only scanner:

```bash
python3 <skill-dir>/scripts/allure_ids.py scan \
  --file <TestFile.kt> \
  --format json
```

python3 <skill-dir>/scripts/allure_ids.py scan \
  --dir <scoped-test-directory> \
  --format json
```

Scanner не меняет файлы и не обращается в сеть. Он возвращает `name`, `fullName`, метод
и устойчивую строку для последующей проверки. `@TestFactory` намеренно пропускается.

## 2. Получи ID

Перед командами `dp allure` полностью прочитай
[references/dp-allure-workflow.md](references/dp-allure-workflow.md). В нём описаны:

- проверка версии CLI;
- автоматический выбор проекта по explicit ID, CI и имени Git-репозитория;
- поиск активных и удалённых дублей;
- безопасное резервирование ровно одного ID на тест.

Переиспользуй однозначно найденный ID. При неоднозначном совпадении запроси выбор вместо
создания ещё одного кейса.

## 3. Примени ID

Сначала получи diff без записи:

```bash
python3 <skill-dir>/scripts/allure_ids.py apply \
  --file <TestFile.kt> \
  --method '<methodName>' \
  --line <testLine> \
  --id <ALLURE_ID> \
  --check
```

Проверь diff и повтори без `--check`. Скрипт:

- вставляет `@AllureId` сразу после `@Test`;
- добавляет Kotlin/Java import;
- сохраняет line endings и права файла;
- не перезаписывает другой существующий ID;
- атомарно заменяет файл и удаляет временный файл.

Если метод или строка изменились после `scan`, выполни scan повторно. Не обходи stale guard
ручной вставкой, пока не сверишь целевой тест.

## 4. Проверь результат

- повтори `scan` для изменённого файла;
- скомпилируй затронутые тесты или выполни минимальную принятую проверку проекта;
- не запускай долгий suite вопреки запрету пользователя;
- удали временные результаты scan и другие локальные артефакты.

В результате укажи найденный project ID, переиспользованные/зарезервированные IDs и
выполненную проверку.
