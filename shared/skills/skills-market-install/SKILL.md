---
name: "skills-market-install"
description: "Установка корпоративных навыков из Skills Market через dp skills install по явному запросу."
source: "auto-skill"
extracted_at: "2026-10-20T09:39:28.278Z"
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


# Установка скилов из корпоративного реестра Skills Market

## Когда применять
Пользователь просит «добавить скилы» из внутреннего GitLab-репозитория (например `https://gitlab.tcsbank.ru/tacp/nessy-skills`) или просто установить корпоративные скилы.

## Почему не git clone
- HTTPS-клон требует логин/пароль (`could not read Username`), креды в `~/.git-credentials` обычно отсутствуют.
- SSH-порт 22 до `gitlab.tcsbank.ru` заблокирован (`Operation timed out`).
- Плагин `dp gitlab` не умеет скачивать файлы/архивы репозитория.

## Рабочий путь: плагин `dp skills` (Skills Market)

Корпоративные скилы публикуются в реестре Skills Market и устанавливаются через Spirit CLI. Реестр автоматически находит скилы по YAML-фронтматтеру `name`/`description` в `SKILL.md` внутри репозиториев.

### 1. Найти, какие скилы есть в репозитории
Если репозиторий известен, но список скилов нет — использовать codeSearch MCP:
`dp_code-search_exact` с query `SKILL.md` и фильтром `repository: <tenant>/<repo>` (например `tacp/nessy-skills`). Результат покажет пути вида `skills/<name>/SKILL.md`.

### 2. Установить скил
```bash
dp skills install <owner>/<skill-name> -a nessy --global
```
- `<owner>` — GitLab-группа/тенант репозитория (например `tacp`).
- `<skill-name>` — имя из пути `skills/<name>/SKILL.md`.
- Обязательно передать `-a nessy` и `--global` (или `--project`) — без них команда требует интерактивный диалог и падает с `Для запуска без диалога передайте --agent и --project или --global`.
- Устанавливается в `~/.nessy/skills/<name>`.

### 3. Полезные команды
- `dp skills list` — показать установленные скилы (колонка `nessy:true` = установлены для Nessy).
- `dp skills update` — обновить установленные скилы.
- `dp skills pack list` — список доступных Skill Packs (например `profession-qa`, `platform-data-cli`).
- `dp skills pack install <pack-id>` — установить целый пак.

## Нюансы
- Скилы становятся доступны в новых сессиях Nessy (список скилов загружается при старте).
- Если скил уже установлен — `dp skills install` перезапишет его; для обновления лучше `dp skills update`.
- Проверка установки: `ls ~/.nessy/skills/` и чтение `SKILL.md` установленного скила.