# markdown-short-table-delimiter

## AIDT

- AIDT-6998

## Зачем

Некоторые модели генерируют markdown-таблицы, где header содержит больше колонок, чем delimiter row. CommonMark-рендереры обычно не считают такой блок таблицей, из-за чего пользователь видит сырой markdown вместо таблицы.

Этот fork-patch делает CLI и Desktop renderer терпимее: delimiter row с меньшим числом колонок считается таблицей, а Desktop дополнительно дополняет недостающие delimiter cells перед markdown-парсингом.

## Файлы

- `packages/cli/src/ui/utils/MarkdownDisplay.tsx`
- `packages/cli/src/ui/utils/MarkdownDisplay.test.tsx`
- `packages/cli/src/ui/utils/__snapshots__/MarkdownDisplay.test.tsx.snap`
- `packages/desktop/packages/ui/src/components/markdown/Markdown.tsx`
- `packages/desktop/packages/ui/src/components/markdown/__tests__/markdown-link-routing.test.ts`

## Откат

1. Убрать `[nessy-fork] markdown-short-table-delimiter` маркеры.
2. Вернуть CLI table detection к строгому совпадению числа header/delimiter колонок.
3. Удалить Desktop normalization helper для markdown tables.
4. Удалить focused tests и snapshot updates, если upstream больше не требует локальной толерантности.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
