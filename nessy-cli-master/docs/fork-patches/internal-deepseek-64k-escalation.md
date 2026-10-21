# internal-deepseek-64k-escalation

## AIDT

AIDT-7525

## Зачем

Снизить max_tokens для ретраев с 384K до 64K для внутренних моделей DeepSeek (tgpt/deepseek-v4-*).

**Проблема:**
- Первый запрос использует CAPPED_DEFAULT_MAX_TOKENS = 8K токенов
- При попадании в лимит (FinishReason.MAX_TOKENS) отправляется retry с 384K токенами
- Модель выделяет память под полные 384K, но ~20% вычислений выбрасывается впустую
- Это существенно влияет на перформанс и стабильность сервинга

**Решение:**
- Для внутренних моделей `tgpt/deepseek-v4-*` escalation limit = 64K
- Для остальных моделей DeepSeek V4 escalation limit = 384K
- 64K достаточно для 99% сценариев вывода

## Файлы

- `packages/core/src/core/tokenLimits.ts` — output-only обработка `tgpt/` и OUTPUT_PATTERNS
- `packages/core/src/core/tokenLimits.test.ts` — тесты на нормализацию и лимиты
- `packages/core/src/core/internal-deepseek-escalation.test.ts` — тесты escalation
- `packages/core/src/core/geminiChat.test.ts` — интеграционные тесты
- `docs/fork-patches/internal-deepseek-64k-escalation.md` — документация
- `docs/fork-patches/README.md` — запись в таблице

## Реализация

Обычная нормализация моделей не изменена и продолжает удалять provider prefix. Только output lookup сохраняет существующий `tgpt/` префикс для `deepseek-v4-*`, чтобы сопоставить его со специальным лимитом. Остальные модели, включая `tgpt/qwen35-*`, используют прежнюю нормализацию.

```typescript
[/^tgpt\/deepseek-v4/, LIMITS['64k']],
[/^deepseek-v4/, LIMITS['384k']],
```

## Откат

1. Удалить паттерн для внутренних моделей из OUTPUT_PATTERNS и output-only сохранение префикса.

2. Удалить тесты:
   - `packages/core/src/core/internal-deepseek-escalation.test.ts`
   - Тесты в `tokenLimits.test.ts` на `tgpt/deepseek-v4-*`
   - Тесты в `geminiChat.test.ts` на escalation limit

4. Удалить этот файл и строку из `docs/fork-patches/README.md`

## Upstream

Не отправлен. Внутренняя оптимизация для tgpt/deepseek-v4-* моделей.
