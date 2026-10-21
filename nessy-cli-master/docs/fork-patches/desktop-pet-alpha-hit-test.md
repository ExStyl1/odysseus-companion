# desktop-pet-alpha-hit-test

## AIDT

-

## Зачем

Прозрачное окно Desktop PET перехватывало клики не только по видимой части
персонажа, но и по прозрачным пикселям прямоугольного кадра спрайта. Из-за
этого пользователь не мог нажимать на элементы приложений под PET и передавать
им фокус.

Патч строит alpha-маску spritesheet и проверяет пиксель текущего кадра под
курсором. Видимые пиксели PET остаются интерактивными, а прозрачные передают
события приложению под окном. Контекстное меню, уведомления и управление
размером сохраняют обычные интерактивные области.

## Файлы

- `packages/desktop/apps/electron/src/main/window-manager.ts` — включает click-through сразу при создании окна PET
- `packages/desktop/apps/electron/src/renderer/components/pet/DesktopPet.tsx` — загружает alpha-маску и переключает режим обработки мыши по контуру текущего кадра
- `packages/desktop/apps/electron/src/renderer/components/pet/NessyPet.tsx` — помечает элемент спрайта для alpha hit-test
- `packages/desktop/apps/electron/src/renderer/pets/pet-hit-test.ts` — преобразует alpha-канал spritesheet в маску и сопоставляет координаты курсора с кадром atlas
- `packages/desktop/apps/electron/src/renderer/pets/pet-hit-test.test.ts` — проверяет прозрачные, непрозрачные и внешние точки

Ключевые кодовые точки помечены
`// [nessy-fork] desktop-pet-alpha-hit-test`.

## Откат

1. Удалить alpha hit-test и вернуть прямоугольную проверку `data-pet-interactive`.
2. Удалить начальное включение `setIgnoreMouseEvents` при создании окна PET.
3. Удалить маркеры `[nessy-fork] desktop-pet-alpha-hit-test`, строку из реестра и этот файл.

## Upstream

Не отправлен.
