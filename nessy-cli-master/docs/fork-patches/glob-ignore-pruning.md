# glob-ignore-pruning

## AIDT

AIDT-7661

## Зачем

Инструмент glob на больших проектах (Android-монорепо, сотни тысяч файлов)
переполнял память: на машине с собранными артефактами рост с ~140 MB до ~3 GB
при 18 найденных файлах, операция прерывалась. Причина — полный обход
сгенерированных каталогов (`build/`, `.gradle/`, `.kotlin/`, `.idea/`):
правила игнорирования (gitignore/nessyignore) применялись ПОСЛЕ обхода
(пост-фильтр), поэтому исключённые каталоги всё равно проходились целиком.

Локально:
- `glob.ts` переведён на `globStream` с `ignore.childrenIgnored`/`ignored` —
  исключённые каталоги не обходятся вовсе (с trailing `/` для каталогов и
  fail-open), а фильтрация файлов выполняется в цикле. Добавлен жёсткий лимит
  собранных результатов (`MAX_GLOB_COLLECTED_ENTRIES`) с ранним остановом.
- `gitIgnoreParser.ts` оптимизирован: построенный `ignore`-объект кэшируется
  по каталогу и переиспользуется (когда нет собственного `.gitignore`).
  Без этого предикат приватизации на каждую директорию замедлял обход в
  ~4.7 раза (19 с vs 4 с) — регрессия, которой у upstream нет, т.к. у него
  иной парсер.

## Файлы

- `packages/core/src/tools/glob.ts` — `globStream` + `ignore.childrenIgnored`
  (приватизация обхода по gitignore/nessyignore), лимит сбора
  `MAX_GLOB_COLLECTED_ENTRIES`, ранний `break`/`stream.destroy()`, `hitLimit`,
  фильтрация файлов в цикле.
- `packages/core/src/utils/gitIgnoreParser.ts` — кэш построенного
  `ignore`-объекта по каталогу в `buildIgnoreInstance`.
- `packages/core/src/tools/glob.test.ts` — тест childrenIgnored-приватизации и
  достижения лимита сбора.

Кодовые точки помечены `// [nessy-fork] glob-ignore-pruning`.

## Откат

Upstream (qwen-code) уже покрывает основную часть фикса (childrenIgnored +
`MAX_GLOB_COLLECTED_ENTRIES` + `globStream` + `hitLimit`) в `glob.ts`; наша
версия — его адаптация под наш API (`respectNessyIgnore`, `config/constants`).
Локальной остаётся оптимизация `gitIgnoreParser.isIgnored`. Если upstream
примет эквивалентный фикс:

1. Свернуть `glob.ts` к апстримной версии, если upstream принял
   childrenIgnored-приватизацию и лимит без конфликтов с нашим
   `respectNessyIgnore`/источником правил.
2. Убрать кэш `ignore`-объекта в `gitIgnoreParser.ts` (`buildIgnoreInstance`),
   если upstream перестанет нуждаться в нём или примет аналогичную
   оптимизацию.
3. Убрать `[nessy-fork]`-комментарии.
4. Оставить тесты как upstream-compatible regression-покрытие, если они
   остаются актуальными.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Основная логика (childrenIgnored + лимит) совпадает с текущим
`upstream/main`, локальная адаптация под nessyignore и оптимизация
`gitIgnoreParser` — fork-only.
