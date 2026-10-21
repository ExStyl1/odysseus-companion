#!/usr/bin/env bash
# Колокейшн-фикстура для скилла ai-doc-generator.
# Чисто текстовый скилл: фикстура даёт валидное рабочее дерево (git-репозиторий).
set -euo pipefail
DIR="${1:?нужен каталог}"
mkdir -p "$DIR"
git -C "$DIR" init -q
git -C "$DIR" config user.email lab@local
git -C "$DIR" config user.name skill-lab
printf 'work dir for ai-doc-generator\n' > "$DIR/README.md"
git -C "$DIR" add -A
git -C "$DIR" commit -qm init
