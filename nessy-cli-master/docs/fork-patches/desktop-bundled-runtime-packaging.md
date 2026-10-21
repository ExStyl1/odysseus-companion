# desktop-bundled-runtime-packaging

## AIDT

AIDT-7451

## Зачем

Packaged Desktop не должен зависеть от Bun или uv в пользовательском `PATH`.
Bun и uv для каждой целевой платформы и архитектуры хранятся в репозитории.
Release-сборка проверяет их закреплённые SHA-256 суммы. Сборка и проверка артефакта завершаются ошибкой, если
runtime отсутствует, не исполняется или имеет неверную архитектуру.

## Файлы

- `.gitlab-ci.yml`
- `packages/desktop/package.json`
- `packages/desktop/apps/electron/electron-builder.yml`
- `packages/desktop/apps/electron/scripts/build-linux.sh`
- `packages/desktop/apps/electron/resources/bin/craft-agent`
- `packages/desktop/apps/electron/resources/bin/craft-agent.cmd`
- `packages/desktop/apps/electron/src/main/bundled-runtime.ts`
- `packages/desktop/apps/electron/src/main/__tests__/bundled-runtime.test.ts`
- `packages/desktop/apps/electron/src/main/index.ts`
- `packages/desktop/packages/session-tools-core/src/runtime/resolve-script-runtime.ts`
- `packages/desktop/packages/shared/src/agent/backend/internal/runtime-resolver.ts`
- `packages/desktop/scripts/build-server.ts`
- `packages/desktop/scripts/build/common.ts`
- `packages/desktop/scripts/desktop-security-contract.test.ts`
- `packages/desktop/scripts/prepare-electron-runtimes.ts`
- `packages/desktop/scripts/verify-macos-release.sh`

## Откат

1. Удалить vendored runtime и их обязательную проверку из Desktop distribution scripts.
2. Вернуть единый legacy-путь Bun и разрешить packaged runtime обращаться к `PATH`.
3. Удалить проверку наличия и архитектуры Bun и uv из release verifier.
4. Удалить downloader, тесты, маркеры, строку из реестра и этот файл.

## Upstream

Не отправлен.
