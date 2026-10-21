# desktop-windows-signing

## AIDT

AIDT-7286, AIDT-7452

## Зачем

Release-сборка Windows должна содержать Authenticode-подпись на приложении,
Chromium DLL, вспомогательных executable, деинсталляторе и NSIS installer.
Tagged pipeline требует сертификат и после упаковки fail-closed проверяет каждую
DLL, не полагаясь только на exit code `osslsigncode`. Загружаемые обновления
проверяются штатным механизмом Electron до запуска.

## Файлы

- `.gitlab-ci.yml`
- `packages/desktop/apps/electron/electron-builder.yml`
- `packages/desktop/scripts/desktop-security-contract.test.ts`
- `packages/desktop/scripts/verify-windows-release.sh`

## Откат

1. Удалить обязательную подпись `.dll` из Windows builder configuration.
2. Удалить post-package DLL verifier из tagged pipeline.
3. Если upstream полностью покрывает Windows signing, удалить оставшуюся настройку Authenticode и проверки обновления.
4. Удалить тесты, маркеры, строку из реестра и этот файл.

## Upstream

Не отправлен.
