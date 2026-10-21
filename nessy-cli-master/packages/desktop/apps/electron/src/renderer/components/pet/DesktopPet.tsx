import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';
import { usePetCompanion } from '@/pets/usePetCompanion';
import { usePetActivityState } from '@/pets/usePetActivityState';
import { usePetNotifications } from '@/pets/usePetNotifications';
import { normalizePetSize } from '@/pets/pet-size';
import {
  createPetAlphaMask,
  isOpaquePetPoint,
  type PetAlphaMask,
} from '@/pets/pet-hit-test';
import { PetNotifications } from './PetNotifications';
import { NessyPet } from './NessyPet';

function ignoreDragError(promise: Promise<void> | undefined): void {
  void promise?.catch(() => {});
}

type ResizeState = {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  startSize: number;
};

// [nessy-fork] desktop-pet-click-activation
type DragStart = {
  screenX: number;
  screenY: number;
};

const PET_CLICK_DRAG_THRESHOLD = 4;

/**
 * Fills the transparent, always-on-top pet window. Everything is clustered at
 * the bottom-right: notification cards stack just above a small toggle, which
 * sits just above the draggable pet. The toggle is pinned right above the pet,
 * so collapse/expand only grows/shrinks the cards above it — the toggle and pet
 * never move.
 *
 * Click-through is per-element via elementFromPoint: only the pet, the cards
 * and the toggle are interactive; everything else passes through to the desktop.
 */
export function DesktopPet() {
  const { t } = useTranslation();
  const { selectedPet, petEnabled, petSize, setPetEnabled, setPetSize } =
    usePetCompanion();
  const state = usePetActivityState();
  const { items, dismiss, answer } = usePetNotifications();
  const [collapsed, setCollapsed] = useState(false);
  const [resizePreview, setResizePreview] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const ignoringRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const didDragRef = useRef(false);
  const resizingRef = useRef<ResizeState | null>(null);
  const resizePreviewRef = useRef<number | null>(null);
  const alphaMaskRef = useRef<PetAlphaMask | null>(null);

  const setIgnore = useCallback((ignore: boolean) => {
    if (ignore === ignoringRef.current) return;
    ignoringRef.current = ignore;
    ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(ignore));
  }, []);

  // [nessy-fork] desktop-pet-alpha-hit-test
  // The mask is decoded asynchronously while mousemove keeps reading it, so the
  // ref is only ever written by the decode that is still current, and cleared in
  // the cleanup — before the next effect starts. A reader therefore sees either
  // the mask of the sprite on screen or null (which falls back to box hit
  // testing), never the mask of the previous pet.
  useEffect(() => {
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      const mask = createPetAlphaMask(
        context.getImageData(0, 0, canvas.width, canvas.height),
      );
      // Only the alpha channel is kept, so release the decoded frame instead of
      // leaving a full-size spritesheet bitmap alive until GC picks it up.
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      alphaMaskRef.current = mask;
    };
    image.src = selectedPet.spritesheetUrl;
    return () => {
      cancelled = true;
      image.onload = null;
      alphaMaskRef.current = null;
    };
  }, [selectedPet.spritesheetUrl]);

  useEffect(() => {
    setIgnore(true);
    const onMove = (event: MouseEvent) => {
      if (draggingRef.current || resizingRef.current) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const sprite = el?.closest?.('[data-pet-sprite]');
      const mask = alphaMaskRef.current;
      const interactive =
        sprite instanceof HTMLElement && mask
          ? isOpaquePetPoint(
              mask,
              sprite.style.backgroundPosition,
              sprite.getBoundingClientRect(),
              event.clientX,
              event.clientY,
            )
          : !!el?.closest?.('[data-pet-interactive]');
      if (!interactive) setContextMenu(null);
      setIgnore(!interactive);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(false));
    };
  }, [setIgnore]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      setContextMenu(null);
      draggingRef.current = true;
      dragStartRef.current = {
        screenX: event.screenX,
        screenY: event.screenY,
      };
      didDragRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      ignoreDragError(
        window.electronAPI?.beginWindowDrag?.(event.screenX, event.screenY),
      );
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.buttons & 1) === 0) return;
      const dragStart = dragStartRef.current;
      if (
        dragStart &&
        Math.hypot(
          event.screenX - dragStart.screenX,
          event.screenY - dragStart.screenY,
        ) >= PET_CLICK_DRAG_THRESHOLD
      ) {
        didDragRef.current = true;
      }
      ignoreDragError(
        window.electronAPI?.moveWindowDrag?.(event.screenX, event.screenY),
      );
    },
    [],
  );

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragStart = dragStartRef.current;
      const isClick =
        event.type === 'pointerup' &&
        dragStart !== null &&
        !didDragRef.current &&
        Math.hypot(
          event.screenX - dragStart.screenX,
          event.screenY - dragStart.screenY,
        ) < PET_CLICK_DRAG_THRESHOLD;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      draggingRef.current = false;
      dragStartRef.current = null;
      didDragRef.current = false;
      void (async () => {
        await window.electronAPI?.endWindowDrag?.();
        if (!isClick) return;
        await window.electronAPI?.petFocusLastWindow?.();
      })().catch(() => {});
    },
    [],
  );

  const updateResizePreview = useCallback((size: number) => {
    const normalized = normalizePetSize(size);
    resizePreviewRef.current = normalized;
    setResizePreview(normalized);
  }, []);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(null);
      resizingRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startSize: resizePreviewRef.current ?? petSize,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      updateResizePreview(resizePreviewRef.current ?? petSize);
    },
    [petSize, updateResizePreview],
  );

  const onPetContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: Math.min(Math.max(8, event.clientX), window.innerWidth - 100),
        y: Math.min(Math.max(8, event.clientY), window.innerHeight - 44),
      });
    },
    [],
  );

  const onClosePet = useCallback(() => {
    setContextMenu(null);
    setPetEnabled(false);
    ignoreDragError(window.electronAPI?.setPetWindowEnabled?.(false));
  }, [setPetEnabled]);

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = resizingRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.screenX - resize.startScreenX;
      const deltaY = event.screenY - resize.startScreenY;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      updateResizePreview(resize.startSize + delta);
    },
    [updateResizePreview],
  );

  const onResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = resizingRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const nextSize = resizePreviewRef.current ?? resize.startSize;
      resizingRef.current = null;
      resizePreviewRef.current = null;
      setResizePreview(null);
      setPetSize(nextSize);
    },
    [setPetSize],
  );

  if (!petEnabled) return null;

  const displayPetSize = resizePreview ?? petSize;

  return (
    <div className="pointer-events-none fixed inset-0 flex flex-col items-end justify-end gap-1.5 p-2.5">
      {items.length > 0 && !collapsed && (
        <PetNotifications items={items} dismiss={dismiss} answer={answer} />
      )}

      {items.length > 0 && (
        <button
          type="button"
          data-pet-interactive
          aria-label="toggle notifications"
          onClick={() => setCollapsed((v) => !v)}
          className="pointer-events-auto flex h-6 items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 text-neutral-500 shadow-xs hover:bg-neutral-50"
        >
          {collapsed && (
            <span className="pl-0.5 text-[11px] font-medium leading-none">
              {items.length}
            </span>
          )}
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <div
        data-pet-interactive
        className="group relative pointer-events-auto cursor-grab active:cursor-grabbing"
        title={selectedPet.displayName}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={onPetContextMenu}
      >
        <NessyPet
          spritesheetUrl={selectedPet.spritesheetUrl}
          state={state}
          size={displayPetSize}
          className="drop-shadow-[0_3px_6px_rgba(0,0,0,0.35)]"
        />
        <button
          type="button"
          data-pet-interactive
          aria-label="resize pet"
          title="Resize pet"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          className={`absolute -bottom-0.5 -right-0.5 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-lg border border-white/15 bg-neutral-900/55 text-white shadow-[0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur transition-opacity hover:bg-neutral-900/70 focus-visible:opacity-100 ${
            resizePreview == null
              ? 'opacity-0 group-hover:opacity-100'
              : 'opacity-100'
          }`}
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>

      {contextMenu && (
        <div
          data-pet-interactive
          className="pointer-events-auto absolute z-50 rounded-md border border-neutral-200 bg-white p-0.5 text-neutral-800 shadow-[0_5px_16px_rgba(0,0,0,0.16)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={onClosePet}
            className="flex h-6 min-w-20 items-center rounded px-2 text-xs hover:bg-neutral-100"
          >
            {t('pet.menu.close')}
          </button>
        </div>
      )}
    </div>
  );
}
