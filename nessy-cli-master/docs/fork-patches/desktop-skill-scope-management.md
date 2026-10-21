# desktop-skill-scope-management

## AIDT

AIDT-7115

## Зачем

Desktop не показывал, какой проект выбран для работы со skills, а Skill Market устанавливал skills только в user scope. Патч добавляет явный выбор рабочей папки проекта, установку из маркетплейса в project или user scope и независимое отображение состояния каждого scope.

Операции установки, включения, отключения и удаления используют выбранную рабочую папку проекта. Для project-установки `dp skills install` получает project-флаг и запускается с выбранной папкой как `cwd`; user-установка остаётся глобальной.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.test.ts` — регрессионные тесты project-установки через `dp` и удаления project skill
- `packages/cli/src/acp-integration/acpAgent.ts` — ACP-операции установки, удаления и изменения состояния для project и user scope
- `packages/cli/src/acp-integration/session/Session.ts` — передача skills с сохранением provider scope
- `packages/desktop/apps/electron/src/renderer/components/app-shell/AppShell.tsx` — выбранный Skills-проект, сохранение рабочей папки и scope-aware действия
- `packages/desktop/apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx` — передача выбранного Skills-проекта в страницы skill и маркетплейса
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillInstallButton.tsx` — выбор project/user scope для установки и удаления
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplaceDetailPanel.tsx` — scope-aware установка и удаление со страницы skill
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplacePanel.tsx` — scope-aware установка и удаление из списка маркетплейса
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx` — независимые элементы skills с учётом provider scope
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillsProjectSelector.tsx` — явный выбор текущего проекта для Skills и Skill Market
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — общий контекст выбранного Skills-проекта
- `packages/desktop/apps/electron/src/renderer/lib/local-storage.ts` — сохранение выбранной рабочей папки для workspace
- `packages/desktop/apps/electron/src/renderer/pages/SkillInfoPage.tsx` — scope-aware отображение, включение и удаление skill
- `packages/desktop/apps/electron/src/shared/types.ts` — Electron API для scope-aware skill-операций
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.marketplace.test.ts` — тесты определения scopes, project-установки и удаления
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — RPC handlers установки, удаления, discovery и синхронизации scopes
- `packages/desktop/packages/server-core/src/handlers/session-manager-interface.ts` — session manager контракт для scoped skill details
- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` — типы marketplace skills с вычисляемыми installed scopes
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — передача scope и scoped skill details через ACP-сессию
- `packages/desktop/packages/shared/src/agent/backend/types.ts` — backend snapshot со scoped skill details
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — разбор и сохранение одинаковых skills из разных scopes
- `packages/desktop/packages/shared/src/protocol/dto.ts` — общий `SkillScope` и scope-aware DTO

## Откат

1. Удалить выбор проекта и scope-aware controls из Skills и Skill Market.
2. Вернуть marketplace install к user scope и убрать передачу project `cwd` и project-флага в `dp`.
3. Вернуть ACP, RPC и session-контракты к единственному глобальному skill и убрать scoped discovery.
4. Удалить регрессионные тесты project/user scope.
5. Удалить маркеры `[nessy-fork] desktop-skill-scope-management`, строку из реестра и этот файл.

## Upstream

Не отправлен.
