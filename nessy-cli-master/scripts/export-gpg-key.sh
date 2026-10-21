#!/usr/bin/env bash
set -euo pipefail

command -v gpg >/dev/null || {
  echo "Установите GPG: brew install gnupg"
  exit 1
}

echo "Доступные секретные ключи:"
gpg --list-secret-keys --keyid-format LONG

echo
read -r -p "Вставьте полный fingerprint без пробелов: " GPG_FINGERPRINT

if ! gpg --list-secret-keys "$GPG_FINGERPRINT" >/dev/null 2>&1; then
  echo "Ошибка: секретный ключ не найден"
  exit 1
fi

gpg --armor --export-secret-keys "$GPG_FINGERPRINT" \
  | base64 \
  | tr -d '\n' \
  | pbcopy

echo
echo "LINUX_GPG_KEY_FINGERPRINT=$GPG_FINGERPRINT"
echo "LINUX_GPG_PRIVATE_KEY_B64 скопирован в буфер обмена."
echo "LINUX_GPG_PASSPHRASE — пароль, заданный при создании ключа."
