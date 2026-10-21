# desktop-linux-update-signing

## AIDT

AIDT-7453

## Зачем

SHA-512 из update manifest не является независимой гарантией подлинности,
поскольку manifest и AppImage публикуются в одном S3. Tagged Linux release
подписывает GPG-ключом AppImage и manifest, а Desktop проверяет обе detached
подписи встроенным публичным ключом с закреплённым fingerprint. Обновление не
переходит в ready и не устанавливается при отсутствии или ошибке подписи;
системный GPG пользователю не требуется.

## Файлы

- `.gitlab-ci.yml`
- `packages/desktop/apps/electron/package.json`
- `packages/desktop/apps/electron/scripts/build-linux.sh`
- `packages/desktop/apps/electron/resources/brands/nessy-cli/linux-update-public-key.asc`
- `packages/desktop/apps/electron/src/main/auto-update.ts`
- `packages/desktop/apps/electron/src/main/linux-update-signature.ts`
- `packages/desktop/apps/electron/src/main/__tests__/auto-update-channel.isolated.ts`
- `packages/desktop/apps/electron/src/main/__tests__/linux-update-signature.test.ts`
- `packages/desktop/bun.lock`
- `packages/desktop/scripts/desktop-security-contract.test.ts`
- `packages/desktop/scripts/sign-linux-release.sh`
- `packages/desktop/scripts/upload.ts`
- `scripts/export-gpg-key.sh`

## Откат

1. Удалить GPG signing AppImage и Linux manifest из release pipeline.
2. Удалить обязательные `.asc` и публичный ключ из проверки перед S3 upload.
3. Удалить встроенный ключ, OpenPGP verifier и проверку manifest/AppImage в updater.
4. Вернуть штатный `autoInstallOnAppQuit`, если установка больше не требует guard.
5. Удалить зависимости, тесты, маркеры, строку из реестра и этот файл.

## Upstream

Не отправлен.
