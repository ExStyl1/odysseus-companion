#!/bin/sh
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }

repo=ExStyl1/WORK
version=0.8.7
archive=
checksum=
destination="$HOME/Applications"
launch=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--version|--archive|--checksum|--destination)
      [ "$#" -ge 2 ] || fail "Нужно значение для $1"
      case "$1" in
        --repo) repo=$2 ;;
        --version) version=$2 ;;
        --archive) archive=$2 ;;
        --checksum) checksum=$2 ;;
        --destination) destination=$2 ;;
      esac
      shift 2 ;;
    --no-open) launch=no; shift ;;
    -h|--help)
      printf '%s\n' 'sh install-companion.sh [--version 0.8.7] [--repo owner/repo] [--no-open]' \
        'Для файла на диске: --archive /путь/к/архиву.zip [--checksum /путь/к/архиву.zip.sha256]'
      exit 0 ;;
    *) fail "Неизвестный аргумент: $1" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || fail 'Companion устанавливается на macOS.'
[ "$(uname -m)" = arm64 ] || [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] ||
  fail 'Этот выпуск рассчитан на Mac с Apple Silicon.'
printf '%s\n' "$repo" | /usr/bin/grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ||
  fail 'Укажите репозиторий в формате owner/repo.'
printf '%s\n' "$version" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  fail 'Укажите версию в формате X.Y.Z.'

mkdir -p "$destination"
destination=$(CDPATH= cd -- "$destination" && pwd -P)
target="$destination/Odysseus Companion.app"
[ ! -L "$target" ] || fail 'Целевой путь является ссылкой.'
lock="$destination/.companion-install.lock"
mkdir "$lock" 2>/dev/null || fail 'В этой папке уже выполняется установка Companion.'
work=
cleanup() {
  if [ -n "$work" ]; then
    if [ -d "$work/previous" ] && [ ! -e "$target" ]; then
      if ! mv "$work/previous" "$target"; then
        printf 'Предыдущая сборка сохранена в %s\n' "$work/previous" >&2
        rmdir "$lock"
        return
      fi
    fi
    rm -rf -- "$work"
  fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
work=$(mktemp -d "$destination/.companion-install.XXXXXX")

asset="Odysseus-Companion-$version-macos-arm64.zip"
if [ -z "$archive" ]; then
  tag="companion-v$version"
  if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
    gh release download "$tag" --repo "$repo" --dir "$work" --pattern "$asset" --pattern "$asset.sha256"
  else
    base="https://github.com/$repo/releases/download/$tag"
    for item in "$asset" "$asset.sha256"; do
      /usr/bin/curl --fail --silent --show-error --location --retry 2 --proto '=https' --proto-redir '=https' --output "$work/$item" "$base/$item" ||
        fail 'Выпуск недоступен. Для приватного репозитория войдите через gh auth login или скачайте архив и SHA256 на GitHub.'
    done
  fi
  archive="$work/$asset"
  checksum="$work/$asset.sha256"
else
  checksum=${checksum:-"$archive.sha256"}
fi

[ -f "$archive" ] && [ -f "$checksum" ] || fail 'Не найден архив или файл SHA256.'
expected=$(/usr/bin/awk 'NR==1 {print tolower($1)}' "$checksum")
printf '%s\n' "$expected" | /usr/bin/grep -Eq '^[0-9a-f]{64}$' || fail 'Некорректный SHA256.'
actual=$(/usr/bin/shasum -a 256 < "$archive" | /usr/bin/awk '{print $1}')
[ "$actual" = "$expected" ] || fail 'Контрольная сумма архива не совпала.'

/usr/bin/ditto -x -k "$archive" "$work/extracted"
candidate="$work/extracted/Odysseus Companion.app"
[ -d "$candidate" ] && [ ! -L "$candidate" ] || fail 'В архиве нет Odysseus Companion.app.'
plist="$candidate/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = app.odysseus.companion ] ||
  fail 'В архиве другое приложение.'
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" = "$version" ] ||
  fail 'Версия приложения не совпадает с выбранным выпуском.'
/usr/bin/file -b "$candidate/Contents/MacOS/Electron" | /usr/bin/grep -q arm64 ||
  fail 'Архитектура приложения не подходит.'
/usr/bin/codesign --verify --deep --strict "$candidate" || fail 'Подпись приложения не прошла проверку.'

if [ -e "$target" ]; then
  [ -d "$target" ] || fail 'Путь установки занят.'
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist")" = app.odysseus.companion ] ||
    fail 'Путь установки занят другим приложением.'
  processes=$(/bin/ps -axo command=) || fail 'Не удалось проверить, закрыто ли приложение.'
  if printf '%s\n' "$processes" | /usr/bin/awk -v path="$target/Contents/MacOS/" 'index($0,path)==1 {found=1} END {exit !found}'; then
    fail 'Закройте Odysseus Companion и повторите установку.'
  fi
  mv "$target" "$work/previous"
fi
mv "$candidate" "$target"
printf 'Установлен Companion %s в %s\n' "$version" "$target"
if [ "$launch" = yes ]; then
  /usr/bin/open "$target"
fi
