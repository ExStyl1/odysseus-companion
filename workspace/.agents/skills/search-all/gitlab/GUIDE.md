---
name: GitLab CLI
description: Работа с репозиториями, merge request'ами и пайплайнами GitLab через dp gitlab CLI (Spirit CLI plugin)
when: |
  - Пользователь просит посмотреть репозитории, merge request'ы или пайплайны в GitLab
  - Пользователь упоминает merge request или MR в контексте GitLab
  - Пользователь хочет узнать статус пайплайна или посмотреть логи упавших задач
  - Пользователь просит показать diff изменений в merge request'е
  - Пользователь упоминает GitLab-проект или тенант
  - Пользователь спрашивает про CI/CD пайплайны
tags: [gitlab, cli, dp, spirit, merge-request, pipeline, repository]
---

# GitLab CLI — работа с репозиториями, MR и пайплайнами через dp gitlab

## Обзор

`dp gitlab` — плагин Spirit CLI для работы с GitLab. Все команды выполняются через Bash tool.

## Команды

### 1. Список репозиториев — `repos`

Получение списка проектов в указанном тенанте.

```bash
dp gitlab repos --tenant <ТЕНАНТ>
```

**Флаги:**

- `--tenant, -t` (обязательный) — тенант GitLab

**Вывод:**

- Количество найденных репозиториев
- Для каждого проекта: название, путь, описание, URL, namespace

```bash
dp gitlab repos --tenant my-team
```

---

### 2. Список merge request'ов — `merge-requests`

Получение списка всех merge request'ов указанного проекта.

```bash
dp gitlab merge-requests --repository <РЕПОЗИТОРИЙ> --tenant <ТЕНАНТ>
```

**Флаги:**

- `--repository, -r` (обязательный) — название репозитория GitLab
- `--tenant, -t` (обязательный) — тенант GitLab

**Вывод:**

- Количество найденных MR
- Для каждого MR: заголовок, автор, статус, URL

```bash
dp gitlab merge-requests --repository admin-front --tenant my-team
```

---

### 3. Детали merge request'а — `merge-request`

Получение детальной информации об одном merge request с полным diff'ом изменений.

```bash
dp gitlab merge-request --repository <РЕПОЗИТОРИЙ> --tenant <ТЕНАНТ> --id <ID>
```

**Флаги:**

- `--repository, -r` (обязательный) — название репозитория GitLab
- `--tenant, -t` (обязательный) — тенант GitLab
- `--id` (обязательный) — ID merge request'а

**Вывод:**

- Информация о MR: заголовок, автор, статус, ветки, описание
- Полный diff всех изменений в MR с контекстом файлов

```bash
dp gitlab merge-request --repository admin-front --tenant my-team --id 42
```

---

### 4. Список пайплайнов — `pipelines`

Получение списка последних 20 пайплайнов репозитория.

```bash
dp gitlab pipelines --repository <РЕПОЗИТОРИЙ> --tenant <ТЕНАНТ>
```

**Флаги:**

- `--repository, -r` (обязательный) — название репозитория GitLab
- `--tenant, -t` (обязательный) — тенант GitLab

**Вывод:**

- Количество найденных пайплайнов
- Для каждого пайплайна: ID, ветка, статус, URL, время обновления/создания
- MR refs автоматически разрешаются в ветку источника

```bash
dp gitlab pipelines --repository admin-front --tenant my-team
```

---

### 5. Детали пайплайна — `pipeline`

Получение детальной информации о конкретном пайплайне с логами упавших/отменённых задач.

```bash
dp gitlab pipeline --repository <РЕПОЗИТОРИЙ> --tenant <ТЕНАНТ> --id <ID>
```

**Флаги:**

- `--repository, -r` (обязательный) — название репозитория GitLab
- `--tenant, -t` (обязательный) — тенант GitLab
- `--id` (обязательный) — ID пайплайна

**Вывод:**

- Информация о пайплайне: ID, статус, ветка, время создания/обновления
- Список всех задач с их статусами
- Полные логи для задач со статусом `failed` или `canceled`

```bash
dp gitlab pipeline --repository admin-front --tenant my-team --id 12345
```

## Правила использования

1. **Оба параметра `--repository` и `--tenant` обязательны** для всех команд, кроме `repos` (там только `--tenant`)
2. **Начинай с `repos`**, если не знаешь точное название репозитория в тенанте
3. **Для ревью MR** используй `merge-request` с `--id` — он покажет полный diff изменений
4. **Для диагностики CI/CD** используй `pipelines` для обзора, затем `pipeline --id` для логов упавших задач
5. **При ошибках** — проверь правильность названия тенанта и репозитория через `dp gitlab repos --tenant <ТЕНАНТ>`
