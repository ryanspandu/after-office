import { useEffect } from 'react'
import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'

// Lists put in order by dragging (threads, notes, pages, folders). A mouse drags after moving a little (a click still
// opens, a right click its menu). A finger: held a moment, its menu (the long press); held on, well past that, the menu
// goes away and the row comes loose to be dragged (a swipe still scrolls, a short hold still opens the menu).

const DRAG_START = 'ao:list-drag'
/** How long a finger holds still before the row comes loose: longer than the phone's long press (its menu). */
const TOUCH_HOLD = 800

export function useListDragSensors() {
  return useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD, tolerance: 8 } }))
}

/** The DndContext's onDragStart: a row came loose (its menu gives way; a finger feels a tick). */
export function listDragStarted() {
  window.dispatchEvent(new Event(DRAG_START))
  navigator.vibrate?.(12)
}

/** A menu (ActionMenu) that gives way when the row it's open on starts being dragged. */
export function useCloseOnListDrag(close: () => void) {
  useEffect(() => {
    window.addEventListener(DRAG_START, close)
    return () => window.removeEventListener(DRAG_START, close)
  }, [close])
}
