# Работа с Allure TestOps через `dp allure`

Читай этот reference только когда требуется найти проект, проверить дубли или зарезервировать ID.

## Проверка CLI

Нужна версия плагина `allure` с командой `get projects`:

```bash
dp allure get projects --help
```

Если команды нет:

```bash
dp plugin install --name=allure
```

Не вызывай `dp allure get token`, не читай и не печатай Allure API token. Для этого workflow токен не нужен.

## Поиск проекта

Используй первый однозначный источник:

1. project ID или точное имя от пользователя;
2. `ALLURE_PROJECT_ID` или аналогичная настройка CI/build;
3. точное имя Git-репозитория из `git remote get-url origin`;
4. имя сервиса или тестового модуля из CI/build.

```bash
dp allure get projects --query '<project-or-repository-name>' --page 0 --size 20
```

Точное совпадение приоритетнее частичного: `distribution-hub`, а не `distribution-hub-airflow`.
Спрашивай пользователя только если точного совпадения нет и осталось несколько равнозначных проектов.

## Поиск дублей

Ищи активные и удалённые кейсы. Сначала используй устойчивую часть `fullName`, иначе `name`.

```bash
dp allure get search-testcases \
  --project-id <PROJECT_ID> \
  --aql-query 'fullName ~= "<class-or-method>"' \
  --deleted false --page 0 --size 20

dp allure get search-testcases \
  --project-id <PROJECT_ID> \
  --aql-query 'fullName ~= "<class-or-method>"' \
  --deleted true --page 0 --size 20
```

Считай кейс тем же тестом, только если финальный сегмент `fullName` точно совпадает с именем метода,
а package/class совместимы. Если `fullName` отсутствует, используй точное совпадение `name`.
Переиспользуй ID найденного кейса, включая удалённый reserved-кейс. При неоднозначности не создавай новый.

## Резервирование

```bash
dp allure reserve testcase \
  --project-id <PROJECT_ID> \
  --name '<DISPLAY_NAME_OR_METHOD_NAME>'
```

Резервируй один ID на один тест и только после проверки дублей. Не резервируй ID «про запас».

Если пользователь явно попросил добавить/создать Allure ID, отдельное повторное подтверждение не нужно.
Если Allure обнаружен автоматически как конвенция в более широкой задаче, следуй текущим правилам
авторизации команды `reserve testcase`. Не обходи их через REST API.
