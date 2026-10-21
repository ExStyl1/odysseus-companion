# agent-read-image-vision-bridge

## AIDT

- AIDT-7163

## Зачем

При text-only основной модели агент мог найти изображение и вызвать `ReadFile`,
но инструмент возвращал сообщение `model doesn't support image input`. Vision
bridge работал только для заранее подготовленных `@`-вложений.

Патч сохраняет изображение внутри `ReadFile`, когда настроена visual-модель,
преобразует его в текст через vision bridge и возвращает транскрипцию основной
модели как обычный результат инструмента. Разрешения `ReadFile` и отмена запроса
остаются частью существующего tool flow.

## Файлы

- `packages/core/src/tools/read-file.ts` — запуск vision bridge для изображений,
  открытых агентом
- `packages/core/src/tools/read-file.test.ts` — регрессия для text-only основной
  модели

Кодовые точки помечены
`// [nessy-fork] agent-read-image-vision-bridge`.

## Откат

1. Удалить сохранение unsupported image и вызов vision bridge из `read-file.ts`.
2. Удалить помеченный регрессионный тест.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
