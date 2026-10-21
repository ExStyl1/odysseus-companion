# desktop-session-content-search

## AIDT

AIDT-7257

## Зачем

Поиск по содержимому сессий в Desktop (Cmd+F) не работал: панель либо не
появлялась, либо находила ноль совпадений. Три причины:

1. **Панель поиска не показывалась.** Инлайн-поиск (`SessionSearchHeader`)
   живёт внутри колонки-навигатора со списком сессий, а её сворачивают, когда
   открыта сессия или активен вид «All Sessions». Условия видимости навигатора
   (`isSessionNavigatorCollapsed`, `isAllSessionsNavigatorHidden`) не учитывали
   активный поиск, поэтому `Cmd+F` выставлял `searchActive`, но вводить запрос
   было негде.
2. **Контентный поиск искал не там.** `searchSessions` сканировал
   `{workspace}/sessions/{id}/session.jsonl`, но в nessy это тонкий метафайл
   (заголовок + первый промпт, без сообщений ассистента и без поля
   `"type":"user|assistant"`). Полный транскрипт лежит в CLI-проекте
   `~/.nessy/projects/{project}/chats/{sdkSessionId}.jsonl`, где `{project}`
   выводится из рабочей директории сессии (её нет в тонком заголовке).
3. **Packaged Desktop не находил встроенный ripgrep.** Бинарник уже входил в
   приложение под `vendor/nessy-cli/vendor/ripgrep/{arch}-{platform}`, но
   resolver искал его в несуществующем `vendor/ripgrep`. Особенно это ломало
   Windows, где системный `rg` обычно не установлен.

Патч разворачивает навигатор с полем поиска при активном `searchActive` и
направляет ripgrep на реальные транскрипты: транскрипты индексируются по имени
файла (`sdkSessionId` глобально уникален), совпадение мапится обратно на
desktop-id сессии. Кнопка Search в боковой панели активирует тот же инлайн-поиск,
что и Cmd+F, без отдельного popup. Заголовок для ранжирования и подсветка в
открытом чате (Cmd+G между совпадениями) продолжают работать.

## Файлы

- `packages/desktop/apps/electron/src/renderer/components/app-shell/AppShell.tsx` — не сворачивать навигатор сессий, пока активен поиск (`isSessionNavigatorCollapsed` / `isAllSessionsNavigatorHidden`); объявление `searchActive`/`searchQuery` поднято выше логики видимости навигатора; кнопка Search активирует этот же поиск вместо popup.
- `packages/desktop/packages/server-core/src/handlers/rpc/sessions.ts` — хендлер `SEARCH_CONTENT`: индексирование транскриптов `~/.nessy/projects/*/chats/*.jsonl` по `sdkSessionId`, резолв транскриптов для сессий воркспейса и обратный маппинг на desktop-id.
- `packages/desktop/packages/server-core/src/services/search.ts` — обобщение `searchSessions`: опции `targets` (искать по явному списку файлов вместо глоба `**/session.jsonl`) и `sessionIdFromPath` (кастомное извлечение id из пути).
- `packages/desktop/packages/shared/src/agent/backend/internal/runtime-resolver.ts` — packaged Desktop использует уже встроенный бинарник ripgrep для текущих архитектуры и платформы; отдельная установка не требуется.

## Откат

1. Убрать `!searchActive` из `isSessionNavigatorCollapsed` и
   `isAllSessionsNavigatorHidden`, вернуть объявление `searchActive`/
   `searchQuery` на прежнее место и вернуть popup кнопки Search.
2. Вернуть хендлер `SEARCH_CONTENT` к `searchSessions(query, sessionsDir, …)`
   без резолва транскриптов.
3. Убрать опции `targets`/`sessionIdFromPath` из `searchSessions` и связанные
   ветки.
4. Вернуть прежний путь `vendor/ripgrep/{rg|rg.exe}` в resolver.
5. Удалить маркеры `[nessy-fork] desktop-session-content-search`, строку из
   реестра и этот файл.

## Upstream

Не отправлен. В upstream (openwork) код идентичен нашему до патча — та же
регрессия видимости навигатора и та же несовместимость формата поиска.
