# GitLab

Используй authenticated read-only GitLab и code-search MCP tools Nessy. Перед первым вызовом сверь runtime schema: имена tools и полей важнее примеров ниже.

## Почему GitLab собирается после остальных источников

Главные GitLab seeds обычно находятся в Jira/Tracker-комментариях, Wiki и Time: полные MR/commit URLs, task IDs, repository paths, branch names и filenames. Поэтому первичный GitLab-поиск создаёт shortlist, а после общей correlation wave GitLab-ветка обязательно получает все новые seeds и делает второй проход. Нельзя завершать GitLab до этого прохода.

## Seed registry

Веди таблицу каждого проверяемого scope:

```text
seed | источник | tenant/repository | стратегия | pages/items | релевантные MR/commits | status
```

Добавляй в неё:

- каждый точный GitLab URL из всех систем;
- каждый task ID и branch name;
- каждый repository path, найденный в задаче, документе, сообщении или commit search;
- исходный login и только подтверждённые источником варианты имени/email.

Путь MR вида `<namespace>/<repo>/-/merge_requests/<iid>` разбирай как `tenant=<namespace>`, `repository=<repo>`, `id=<iid>`. Вложенный namespace может состоять из нескольких сегментов. Не включай repository в tenant.

## Воронка

### 1. Прямые ссылки

Сначала прочитай `merge-request` для **каждого** известного MR URL. Проверь URL, title, author username/name, доступные даты, state и связь с целью. Diff/comments загружай только когда без них нельзя установить вклад или результат. `Updated At` не является `Merged At`: если tool не возвращает отдельную дату merge, не придумывай её и пиши «точная дата merge недоступна».

`404` не превращает ссылку в отсутствие MR: сначала повторно проверь разбор tenant/repository/IID и исходный URL. После двух корректно scoped попыток зафиксируй `unresolved` и точную ошибку.

### 2. Repository discovery по задачам

Для каждого task ID выполни отдельный `code-search commits`; затем при необходимости `exact` и `search`. Начинай с scope, известного из источника, и расширяй до tenant/group только если narrow-поиск не дал кандидата. Из релевантных результатов переноси repository и commit URL в registry.

Термины цели используй короткими независимыми запросами. Один длинный OR-запрос не заменяет task-ID и exact-term проходы.

### 3. MR inventory по автору

В каждом обнаруженном repository вызови `merge-requests` с точным `author=<employee login>`, `state=all`. Начни с bounded limit; увеличь его или используй полную пагинацию, пока выборка не охватит `search_window` либо platform cap.

Список MR может не содержать дат. Тогда последовательно читай детали MR из author-list, пока не доказана временная граница: получены все MR, которые могут пересекать `search_window`, и просмотрен более старый MR за нижней границей. Если порядок выдачи или граница не доказаны, статус repository остаётся `partial`.

Для всех MR внутри `search_window` сохрани точную дату, state, URL и роль сотрудника. Для MR с task ID/терминами целей прочитай детали независимо от даты списка и классифицируй относительно `review_period`.

### 4. Commit inventory

В каждом обнаруженном repository выполни paginated `code-search commits --query <employee login>`. Оставляй в author inventory только результаты, где поле `Author` или `Committer` действительно совпадает с подтверждённой identity и дата входит в `search_window`.

Совпадение login в commit message, diff или bot-generated metadata — это mention, а не авторство. Не суммируй такие результаты с личными commits. Глобальный счётчик вроде «тысячи commits по запросу login» без проверки author, scope и dates является шумом и не считается покрытием.

Отдельно ищи commits по каждому task ID и короткому термину цели. Они могут найти repository или командный результат, но личный вклад подтверждают только поля роли.

### 5. Проверка shortlist

Для релевантных MR/commits проверь достаточные для вывода поля: author/committer, reviewers или comments при заявлении review/coordination, доступные dates, state/merge SHA и существенный diff. Не используй `updated_at` как доказательство merge или production outcome. Различай:

- author MR;
- author или committer commit;
- reviewer;
- участник discussion;
- упомянутый сотрудник;
- service account или bot.

MR из буфера учитывай только при связи с работой `review_period`; иначе это context-only.

## GitLab completion gate

Перед сводкой выведи registry и воронку:

```text
direct URLs → resolved MR
task IDs → repositories
author MR candidates → in-window verified MR
login commit hits → exact-author in-window commits
goal candidates → verified evidence items
```

GitLab нельзя пометить `complete`, пока:

1. проверен каждый GitLab URL, полученный от пользователя и других system branches;
2. выполнен второй проход после correlation wave;
3. в каждом обнаруженном repository пройдены author MR inventory, author commit inventory и goal/task-ID searches;
4. пагинация и временная граница доказаны либо явно указан platform cap;
5. нулевой результат подтверждён минимум прямыми URL, author inventory и task-ID/goal strategies, а не единственным поиском.

Неизвестный общий repository scope, недоказанная временная граница, truncation/cap или непрочитанные cross-system URLs означают `partial`. `0 direct MR` допустимо только после этого gate.
