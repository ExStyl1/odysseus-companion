# desktop-plan-permission-flow

## AIDT

-

## Зачем

Desktop получает от CLI permission request для выхода из plan mode через `ExitPlanMode`. Upstream Desktop отображает этот запрос как admin approval и выбирает generic allow option, что теряет специальный `restore_previous` outcome и плохо показывает сам план.

Этот fork-patch делает flow совместимым с текущим CLI: `switch_mode` идет как обычная mutation-permission, план передается целиком и автоматически показывается markdown'ом в существующей боковой preview-панели, а permission-карточка остается компактной. Ответ выбирает `restore_previous`/`proceed_once` только если такие optionId реально пришли от CLI.

## Файлы

- `packages/desktop/packages/shared/src/agent/nessy-agent.ts`
- `packages/desktop/packages/shared/src/agent/__tests__/nessy-agent-models.test.ts`
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`
- `packages/desktop/apps/electron/src/renderer/hooks/useLinkInterceptor.ts`
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx`
- `packages/desktop/apps/electron/src/renderer/App.tsx`

## Откат

1. Убрать `[nessy-fork] desktop-plan-permission-flow` маркеры.
2. Вернуть `switch_mode` к upstream permission type, если upstream Desktop начнет корректно различать plan approval.
3. Удалить `plan` preview state и callbacks для открытия/закрытия плана в боковой панели.
4. Вернуть специальный markdown-рендер ExitPlanMode в Desktop permission card.
5. Вернуть upstream-логику выбора optionId, если upstream гарантирует корректный outcome для `restore_previous` и отсутствующих allow options.
6. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
