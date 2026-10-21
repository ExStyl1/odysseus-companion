# desktop-installer-cyrillic-temp

## AIDT

AIDT-7201

## Зачем

При кириллическом имени Windows-профиля `%TEMP%` может содержать короткий
8.3-путь. PowerShell `Remove-Item` ошибочно считает такой путь
несуществующим, а запущенный из него NSIS installer может завершиться с
`0xC0000005`.

Fork-patch скачивает installer в уникальный каталог внутри `%ProgramData%` и
передаёт этот ASCII-путь как `TEMP` и `TMP` процессу NSIS. Значения окружения
родительского PowerShell сразу восстанавливаются. Очистка каталога через
`System.IO.Directory` обходит ошибку нормализации пути в PowerShell
FileSystemProvider и выполняется как после успешной установки, так и перед
выходом с ошибкой.

Баг PowerShell: https://github.com/PowerShell/PowerShell/issues/21070

## Файлы

- `packages/desktop/scripts/install-app.ps1`

## Откат

1. Убрать `[nessy-fork] desktop-installer-cyrillic-temp` маркер.
2. Вернуть загрузку в пользовательский `%TEMP%` и очистку через `Remove-Item`,
   если upstream, PowerShell и NSIS исправят этот сценарий.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
