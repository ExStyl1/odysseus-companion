/**
 * UA12.21 (OQ-14) — keyboard drag on the board: a tile moves between columns with the keyboard alone, through the
 * same drop the pointer makes (`KanbanBoard.handleDragEnd` → `onMoveTask`, which applies the column's drop status).
 *
 * WHERE THIS COMES FROM, in the AGENTS.md order. Upstream's board has no keyboard drag at v0.13.4, v0.13.6 or v0.14.0
 * (its `KanbanBoard.tsx` registers only the pointer sensor), so there is no parity to keep. The mechanism is the drag
 * library's own: dnd-kit's `KeyboardSensor`, the sensor upstream's own `ui/sortable-list.tsx` registers "for
 * accessibility", with dnd-kit's live-region announcements and screen-reader instructions — configured, not rebuilt.
 * Three choices dnd-kit's defaults do not make for a board, each stated:
 *
 *  1. **Space picks up; Space, Enter or Tab drops.** dnd-kit starts and ends on Space AND Enter, and the tile already
 *     opens on Enter. A card at rest therefore opens on Enter only and Space is the pick-up key (the
 *     react-beautiful-dnd convention); during a move the drop keys are dnd-kit's own end set — Space, Enter, Tab (so
 *     focus cannot leave mid-drag) — and Escape cancels with nothing moved. The card's own Enter handler stands down
 *     while its tile is being dragged (`TaskTile`'s `dragging`): focus stays on the card during a move and its handler
 *     runs before dnd-kit's document listener, so before LF-6-fix's follow-up an Enter mid-move opened the task, left
 *     the board, and left the drag running headless (see {@link cancelBoardDrag}).
 *  2. **Only the tile itself starts a drag.** A Space on one of the tile's own controls (the status picker, the
 *     subtask toggle, the composer — each marked `data-no-dnd`, the marker the pointer sensor already honours) is
 *     that control's, never a pick-up. See {@link isTileKeyboardDragTarget}.
 *  3. **Left/Right jump a whole column.** dnd-kit's default getter nudges 25 px per press; placement here is per
 *     column (a column has no order), so {@link boardColumnCoordinates} moves the dragged tile onto the next or
 *     previous column. Up/Down do nothing.
 */
import {
  KeyboardCode,
  KeyboardSensor,
  type Announcements,
  type KeyboardCodes,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core'

/**
 * The board's `DndContext` id. dnd-kit names its hidden screen-reader instructions element after it
 * (`useUniqueId('DndDescribedBy', id)` returns the id itself), so a tile can point `aria-describedby` at it.
 */
export const BOARD_DND_ID = 'kanban-board-dnd'

/**
 * Space picks up; Space, Enter or Tab drops (dnd-kit's own default end set); Escape cancels. Enter never STARTS a
 * drag — at rest it is the tile's open action.
 */
export const BOARD_KEYBOARD_CODES: KeyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
}

/**
 * Cancel a live board drag, for the board's unmount cleanup. dnd-kit 6.3.1's `DndContext` does not stop its active
 * sensor when it unmounts: the sensor's document listener outlives the board, and the next Space, Enter or Tab typed
 * ANYWHERE (say, in the chat composer the user navigated to) is swallowed and ends the hidden drag through the
 * unmounted board's `handleDragEnd` — a column move and drop status the user never saw. Every dnd-kit sensor (the
 * keyboard one and the pointer one) cancels on the window's `resize` event, so the cleanup dispatches one: the
 * library's own cancel path (`onDragCancel`, nothing moved), with no private API touched. A synthetic `resize` only
 * makes resize listeners re-measure; a synthetic Escape (the other option) could reach the app's own Escape
 * handlers, so it is not used.
 */
export function cancelBoardDrag(win: Pick<EventTarget, 'dispatchEvent'>): void {
  win.dispatchEvent(new Event('resize'))
}

/** The minimal element surface the target check reads, so it can be exercised without a DOM. */
interface ElementLike {
  closest(selector: string): ElementLike | null
  querySelector?(selector: string): unknown
}

/**
 * Whether a keydown's target may start a keyboard drag: the tile's own card — the first `[role="button"]` inside a
 * `[data-kanban-task]` wrapper — and nothing marked `data-no-dnd` (the tile's own controls). A Space typed into the
 * subtask composer or pressed on the status picker stays with that control.
 */
export function isTileKeyboardDragTarget(target: unknown): boolean {
  const element = target as ElementLike | null
  if (!element || typeof element.closest !== 'function') return false
  if (element.closest('[data-no-dnd="true"]')) return false
  const wrapper = element.closest('[data-kanban-task]')
  if (!wrapper || typeof wrapper.querySelector !== 'function') return false
  return wrapper.querySelector('[role="button"]') === element
}

/** dnd-kit's `KeyboardSensor`, started only from a tile card (see {@link isTileKeyboardDragTarget}). */
export class BoardKeyboardSensor extends KeyboardSensor {
  static activators: typeof KeyboardSensor.activators = KeyboardSensor.activators.map(activator => ({
    eventName: activator.eventName,
    handler: (event, options, context) =>
      isTileKeyboardDragTarget(event.target) && activator.handler(event, options, context),
  }))
}

/**
 * Left/Right move the dragged tile onto the previous/next column in board order; any other key, the first or last
 * column, or a column whose rect is not measured yields nothing (dnd-kit then leaves the tile where it is).
 */
export function boardColumnCoordinates(getColumnOrder: () => readonly UniqueIdentifier[]): KeyboardCoordinateGetter {
  return (event, { context }) => {
    const step = event.code === KeyboardCode.Right ? 1 : event.code === KeyboardCode.Left ? -1 : 0
    if (step === 0) return undefined
    const order = getColumnOrder()
    const from = context.over ? order.indexOf(context.over.id) : -1
    if (from < 0) return undefined
    const target = order[from + step]
    if (target === undefined) return undefined
    const rect = context.droppableRects.get(target)
    if (!rect) return undefined
    const width = context.collisionRect?.width ?? 0
    // Centred horizontally in the column, near its top: inside the column's rect, so the board's
    // `closestCorners` collision reads that column as the one under the tile.
    return { x: rect.left + Math.max(0, (rect.width - width) / 2), y: rect.top + 8 }
  }
}

/** The subset of i18next's `t` the announcements use. */
export type AnnounceT = (key: string, options: Record<string, string>) => string

/**
 * dnd-kit's live-region announcements and screen-reader instructions, in the user's language (dnd-kit's own are
 * English and name the draggable by its id). A task is named by its title, a column by its header label.
 */
export function boardDragAccessibility(
  t: AnnounceT,
  titleOf: (taskId: UniqueIdentifier) => string,
  columnOf: (taskId: UniqueIdentifier) => string,
  columnLabelOf: (columnId: UniqueIdentifier) => string,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  return {
    screenReaderInstructions: { draggable: t('kanban.drag.instructions', {}) },
    announcements: {
      onDragStart: ({ active }) =>
        t('kanban.drag.pickedUp', { task: titleOf(active.id), column: columnOf(active.id) }),
      onDragOver: ({ active, over }) => over
        ? t('kanban.drag.over', { task: titleOf(active.id), column: columnLabelOf(over.id) })
        : t('kanban.drag.overNone', { task: titleOf(active.id) }),
      onDragEnd: ({ active, over }) => over
        ? t('kanban.drag.dropped', { task: titleOf(active.id), column: columnLabelOf(over.id) })
        : t('kanban.drag.droppedNone', { task: titleOf(active.id) }),
      onDragCancel: ({ active }) =>
        t('kanban.drag.cancelled', { task: titleOf(active.id), column: columnOf(active.id) }),
    },
  }
}

/**
 * The column a finished drag moves its tile to, or `null` for no move: dropped outside every column, an unknown
 * tile, or its own column. The pointer and the keyboard end here alike (`KanbanBoard.handleDragEnd`); a cancelled
 * drag (Escape) never reaches it.
 */
export function boardDropTarget(
  tasks: readonly { id: string; column: string }[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier | null | undefined,
): string | null {
  if (overId === null || overId === undefined) return null
  const task = tasks.find(t => t.id === String(activeId))
  const toColumn = String(overId)
  if (!task || task.column === toColumn) return null
  return toColumn
}
