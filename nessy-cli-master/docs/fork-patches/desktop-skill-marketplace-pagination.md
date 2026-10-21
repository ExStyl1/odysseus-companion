# desktop-skill-marketplace-pagination

## AIDT

AIDT-7524

## Зачем

Каталог навыков отдаёт максимум 100 навыков на страницу (сортировка по установкам).
Пользователь открывает навык из поиска или по прямой ссылке — карточка показывает
заглушку, установка не работает. Свежие и draft-навыки с нулём установок попадают
под это гарантированно.

Этот форк-патч разрешает навык по идентификатору в каталоге независимо от того,
попал ли он в текущую страницу выдачи:

- Используется канонический адрес навыка из реестра (tenant/name) как источник
  установки, а не ссылка-обёртка на веб-интерфейс
- Загрузка через `/v2/registry/entries/agent-skill/{detailsId}` напрямую
- Fallback на поиск по `folder_name` через `q` параметр для навыков вне первой
  страницы
- Показ индикатора загрузки в карточке навыка вместо пустой заглушки

## Файлы

- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` —
  функции `fetchRegistryEntry()`, `skillFromRegistryEntry()`, `findListedSkill()`,
  `parseInstallCommandSource()`, `directSkillSource()` для загрузки навыков
  вне первой страницы
- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` —
  типы `SkillInstallDto`, `SkillRegistryEntryDto` для работы с registry entry
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — RPC метод
  `MARKETPLACE_GET` для загрузки детализации навыка по идентификатору
- `packages/desktop/packages/server-core/src/services/internal-marketplace.test.ts` —
  тесты на загрузку навыка вне первой страницы каталога через registry entry
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.marketplace.test.ts` —
  тесты на `getSkill` с `detailsId`
- `packages/desktop/packages/shared/src/protocol/channels.ts` — RPC канал
  `MARKETPLACE_GET`
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplaceDetailPanel.tsx` —
  индикатор загрузки детализации навыка

## Откат

1. Удалить функции `fetchRegistryEntry()`, `skillFromRegistryEntry()`,
   `findListedSkill()` из `internal-marketplace.ts`.
2. Удалить функции `parseInstallCommandSource()`, `directSkillSource()` — вернуться
   к прямой передаче `install.command`.
3. Удалить типы `SkillInstallDto`, `SkillRegistryEntryDto`.
4. Удалить RPC метод `MARKETPLACE_GET` и обработчик в `skills.ts`.
5. Удалить тесты на загрузку навыков вне первой страницы.
6. Удалить индикатор загрузки из UI компонентов.
7. Удалить маркеры `// [nessy-fork] desktop-skill-marketplace-pagination`.

## Upstream

Не отправлен. Внутренняя фича Desktop для работы с навыками вне первой страницы
каталога.
