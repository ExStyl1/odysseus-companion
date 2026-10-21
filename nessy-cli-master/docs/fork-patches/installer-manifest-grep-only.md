# installer-manifest-grep-only

## AIDT

-

## Зачем

Desktop installer должен работать в минимальном shell-окружении, где есть `curl` или `wget`, но нет `yq`. Upstream path с опциональным `yq` дает два разных способа парсинга одного manifest и лишнюю ветку поведения.

Этот fork-patch всегда извлекает `version` из YAML manifest через уже используемые `grep`/`sed`.

## Файлы

- `packages/desktop/scripts/install-app.sh`

## Откат

1. Убрать `[nessy-fork] installer-manifest-grep-only` маркер.
2. Вернуть проверку `HAS_YQ` и ветвление через `yq`, если upstream сохранит этот контракт.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
