# ide-undici-fetch-interop

## AIDT

-

## Зачем

`/ide enable` подключается к IDE MCP server через
`StreamableHTTPClientTransport` и передает кастомный `fetch`, чтобы обойти
прокси для локального IDE host. В некоторых runtime/bundle-вариантах
динамический импорт `undici` возвращает `fetch` не как top-level export, а через
`default.fetch`. Прямое чтение top-level `fetch` приводит к ошибке
`fetchFn is not a function` и разрыву IDE connection.

Нормализуем форму импорта `undici` в отдельном helper: сначала используем
top-level `fetch`, затем `default.fetch`. Если ни один вариант недоступен,
оставляем явную ошибку вместо молчаливого неверного вызова.

## Файлы

- `packages/core/src/ide/ide-client.ts` — helper для выбора `undici.fetch` из
  ESM/CJS-shaped импорта.
- `packages/core/src/ide/ide-client.test.ts` — регрессия на bundled-shaped
  import, где `fetch` доступен только через `default`.

Кодовая точка помечена `// [nessy-fork] ide-undici-fetch-interop`.

## Откат

Если upstream или сборка `undici` стабильно гарантирует top-level `fetch`:

1. Удалить helper и вернуть прямое чтение `fetch` в `createProxyAwareFetch()`.
2. Удалить focused-тест на `default.fetch`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
