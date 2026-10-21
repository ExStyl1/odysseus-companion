# dp-auth-single-startup-auth

## AIDT

AIDT-7428

## Зачем

При запуске CLI отдельный сбор статистики авторизации последовательно запускал
тот же полный DP Auth flow, что и штатная начальная авторизация. Из-за этого CLI
дважды получал DP-токен, обменивал его на JWT и запрашивал список моделей.

Этот fork-патч оставляет единственным владельцем startup refresh штатную
начальную авторизацию. Она же отправляет в Statist одно событие с результатом.
Для успешного DP Auth идентификаторы пользователя берутся из актуального
exchanged или delegated JWT. Ошибка Statist не влияет на результат авторизации,
а при неуспешном refresh identity из старого JWT не используется.

## Файлы

- `packages/cli/src/core/auth.ts`
- `packages/cli/src/core/auth.test.ts`
- `packages/cli/src/core/initializer.ts`
- `packages/cli/src/core/initializer.test.ts`
- `packages/cli/src/core/forcedAuth.ts` — удалён
- `packages/cli/src/core/forcedAuth.test.ts` — удалён

Кодовые точки помечены
`// [nessy-fork] dp-auth-single-startup-auth`.

## Откат

1. Вернуть отдельный startup flow для сбора статистики авторизации.
2. Убрать отправку Statist Auth из штатной начальной авторизации.
3. Восстановить удалённые модуль и тесты отдельной forced-авторизации.
4. Удалить регрессионные тесты единственного DP refresh.
5. Удалить маркеры, строку из реестра и этот файл.

## Upstream

Не отправлен.
