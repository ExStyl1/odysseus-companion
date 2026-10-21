# desktop-skill-scope-resolution

## AIDT

AIDT-7524

## Зачем

Nessy ACP может сообщать некорректный scope для навыков. Например, навык `Search All`
физически находится в проекте, но ACP возвращает `level=user`. Из-за этого навык не
отображался в Marketplace с правильной меткой scope.

Этот форк-патч определяет scope по фактическому расположению файлов навыка, а не
только по данным от Nessy ACP:

- Навыки из `~/.nessy/skills/` и `~/.agent/skills/` → `global`
- Навыки из `<project>/.nessy/skills/` и `<project>/.agent/skills/` → `project`
- Навыки, установленные в нескольких областях, отображаются с обеими метками
  (например, `wiki (global, project)`)

## Файлы

- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — функции
  `getInstalledMarketplaceSkillScopes()`, `installedSkillDirectory()`,
  `normalizeSkillDirectory()` для определения scope по расположению файлов
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — логирование
  `SKILLS_MARKETPLACE_DISCOVERY`, `[SKILL_SCOPE]`, `SKILLS_MARKETPLACE_SCOPES`
- `packages/cli/src/acp-integration/session/Session.ts` — функция
  `skillLevelFromPath()` для определения storage level из пути файла
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplacePanel.tsx` —
  отображение нескольких scope в карточке навыка
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx` —
  отображение меток scope в списке навыков

## Откат

1. Удалить функцию `installedSkillDirectory()` и `normalizeSkillDirectory()` из
   `skills.ts`.
2. Удалить логику определения scope по расположению файлов в
   `getInstalledMarketplaceSkillScopes()` — вернуться к использованию только
   данных от ACP.
3. Удалить логирование `SKILLS_MARKETPLACE_DISCOVERY`, `[SKILL_SCOPE]`,
   `SKILLS_MARKETPLACE_SCOPES`.
4. Удалить функцию `skillLevelFromPath()` из `Session.ts`.
5. Удалить отображение нескольких scope в UI компонентов.
6. Удалить маркеры `// [nessy-fork] desktop-skill-scope-resolution`.

## Upstream

Не отправлен. Внутренняя фича Desktop для корректного определения scope навыков
независимо от данных ACP.
