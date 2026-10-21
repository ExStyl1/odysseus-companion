# desktop-skill-parse-error-display

## AIDT

AIDT-7524

## Зачем

Навык с невалидным `SKILL.md` раньше исчезал из списка доступных — `listSkills()`
и `loadSkillsFromDir()` просто пропускали его. Пользователь не мог увидеть ошибку
валидации и не мог удалить битый навык через UI Desktop.

Этот форк-патч сохраняет ошибки парсинга в `skillManager` и передаёт их в Desktop
как `parseError` в метаданных навыка. Desktop показывает бейдж "ошибка" с тултипом,
содержащим сообщение валидации. Удаление навыков теперь работает даже при ошибке
парсинга — fallback на имя директории вместо frontmatter name.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts` — удаление навыка с fallback на
  directory name при ошибке парсинга
- `packages/cli/src/acp-integration/session/Session.ts` — сбор ошибок парсинга и
  передача в snapshot как `parseError`, функция `skillLevelFromPath()` для
  определения storage level из пути
- `packages/core/src/skills/skill-manager.ts` — snapshot ошибок парсинга перед
  refresh'ом, удаление воспроизведённых ошибок после сканирования
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx` —
  отображение бейджа ошибки и тултипа
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplacePanel.tsx` —
  отображение ошибок в Marketplace списке
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplaceDetailPanel.tsx` —
  отображение ошибки в деталях навыка
- `packages/desktop/apps/electron/src/renderer/event-processor/handlers/session.ts` —
  передача `scopedSkillDetails` с `parseError` в сессию
- `packages/desktop/apps/electron/src/renderer/event-processor/types.ts` — типы
  для `scopedSkillDetails`
- `packages/desktop/apps/electron/src/renderer/lib/nessy-capability-cache.ts` —
  маппинг `parseError` в `LoadedSkill`
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — маппинг
  `parseError` в `AvailableSkillDetail`
- `packages/desktop/packages/shared/src/i18n/locales/*.json` — строки
  `skillsList.parseErrorBadge` и `skillsList.parseErrorTooltip` для всех языков
- `packages/desktop/packages/shared/src/protocol/dto.ts` — `parseError` в
  `SkillMarketplaceItem` и `scopedSkillDetails` в `Session`
- `packages/desktop/packages/shared/src/skills/types.ts` — `parseError` в
  `LoadedSkill`
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — передача
  `parseError` в `withInstalledScopes()`
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` —
  сохранение `scopedSkillDetails` в managed session
- `packages/cli/src/utils/dp-skills-lock.ts` — **удалён** (больше не нужен для
  `listDpManagedSkills()` в buildAvailableCommandsSnapshot)

## Откат

1. Удалить обработку ошибок парсинга в `acpAgent.ts` и `Session.ts` — вернуть
   прямой вызов `parseSkillContent()` без try/catch.
2. Удалить функцию `skillLevelFromPath()` из `Session.ts`.
3. Удалить snapshot логику в `skill-manager.ts` — вернуть `parseErrors.clear()`.
4. Удалить поле `parseError` из интерфейсов `AvailableCommandsSnapshot`,
   `AvailableSkillDetail`, `SkillMarketplaceItem`, `LoadedSkill`.
5. Удалить передачу `scopedSkillDetails` в `SessionManager.ts` и
   `nessy-agent.ts`.
6. Удалить строки i18n `skillsList.parseErrorBadge` и `skillsList.parseErrorTooltip`.
7. Восстановить `dp-skills-lock.ts` и его использование в
   `buildAvailableCommandsSnapshot()`.
8. Удалить маркеры `// [nessy-fork] desktop-skill-parse-error-display`.

## Upstream

Не отправлен. Внутренняя фича Desktop для отображения ошибок валидации навыков.
