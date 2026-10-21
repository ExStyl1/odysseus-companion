# desktop-skill-marketplace-install-state

## AIDT

AIDT-7459

## Зачем

Desktop сопоставлял marketplace skills с установленными только по имени и формировал registry address из tenant и display slug. Для навыков с одинаковыми именами это приводило к неверным Installed-бэйджам, установке другого registry skill и ложным конфликтам с уже установленным навыком.

Патч получает точный canonical address по skill ID, сверяет managed-установки с global и project lock `dp`, различает user/project scope и оставляет name/description fallback только для unmanaged и legacy skills. Marketplace показывает отдельные `U` и `P` бэйджи, загружает детали по canonical ID и обновляет обе установки основной кнопкой, если skill установлен в обоих scope.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.test.ts` — проверка установки registry address через `dp`
- `packages/cli/src/acp-integration/acpAgent.ts` — маршрутизация registry address в managed `dp` installer
- `packages/cli/src/acp-integration/session/Session.ts` — добавление managed skill ID из lock в discovery snapshot
- `packages/cli/src/utils/dp-skills-lock.ts` — чтение managed skills из global и project lock `dp`
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillInstallButton.tsx` — стабильная кнопка Update и обновление обоих scope
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplaceDetailPanel.tsx` — детали по canonical ID и полные scope-бэйджи
- `packages/desktop/apps/electron/src/renderer/components/app-shell/SkillMarketplacePanel.tsx` — компактные `U` и `P` бэйджи над кнопками
- `packages/desktop/packages/core/src/types/message.ts` — managed skill ID в provider snapshot
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.marketplace.test.ts` — регрессии identity-first matching и одинаковых имён
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — сопоставление installed state по canonical ID и scope
- `packages/desktop/packages/server-core/src/services/internal-marketplace.test.ts` — регрессии canonical address и details ID
- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` — получение canonical address и деталей через v2 API
- `packages/desktop/packages/shared/src/protocol/dto.ts` — install source и details ID в marketplace DTO

## Откат

1. Удалить чтение global/project lock `dp` и managed ID из discovery snapshot.
2. Вернуть сопоставление installed state по имени и формирование registry address из tenant/display slug.
3. Вернуть загрузку деталей через legacy source URL и прежние controls без отдельных `U`/`P` бэйджей и Update both.
4. Удалить регрессионные тесты, маркеры `[nessy-fork] desktop-skill-marketplace-install-state`, строку из реестра и этот файл.

## Upstream

Не отправлен.
