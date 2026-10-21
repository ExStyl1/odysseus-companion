# vision-bridge-dlh-event

## AIDT

AIDT-7139

## Зачем

Отливка события в DLH при использовании vision bridge для распознавания картинок.
Это требуется для аудита и анализа использования VL-моделей — фиксируем факт
обращения к vision модели, количество отправленных изображений, статус выполнения
и метаданные модели.

## Файлы

- `packages/core/src/telemetry/nessy-dlh/events/vision-bridge.ts` — новая функция
  `emitDlhVisionBridge()` для отправки события в DLH; session ID берётся из
  DLH-контекста или активного `Config` без потери receiver
- `packages/core/src/telemetry/nessy-dlh/dlh-context.ts` — безопасный fallback
  `getDlhSessionId()` на `unknown` для неполного контекста
- `packages/core/src/telemetry/nessy-dlh/events/vision-bridge.test.ts` —
  регрессия для получения session ID и fallback на `unknown` без контекста
- `packages/core/src/services/visionBridge/vision-bridge-service.ts` — вызовы
  `emitDlhVisionBridge()` в точках завершения vision bridge (успех, ошибка, отмена)

## Откат

1. Удалить вызовы `emitDlhVisionBridge()` из `vision-bridge-service.ts`
2. Удалить файл `packages/core/src/telemetry/nessy-dlh/events/vision-bridge.ts`
3. Удалить строку из `docs/fork-patches/README.md`
4. Удалить этот файл

## Upstream

Не отправлен.
