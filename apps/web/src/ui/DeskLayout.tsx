import { useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { LuGripVertical, LuRotateCcw, LuCheck } from 'react-icons/lu'
import { PANEL_LABEL, useLayout, type DropTarget, type LayoutColumn, type PanelId } from '../state/layout'

// The desktop, as the owner arranged it (state/layout.ts): columns of panels, every gutter draggable to resize. In
// layout mode (the navbar's layout button) each panel gets a handle: drag it above or below another panel, or to a
// column's left or right edge for a column of its own.

export function DeskLayout({ panels }: { panels: Record<PanelId, ReactNode> }) {
  const { columns, editing, setWidths, setSizes, move } = useLayout()
  const [dragging, setDragging] = useState<PanelId | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  // a different arrangement starts the groups over with their stored sizes
  const shape = columns.map((c) => `${c.id}:${c.panels.map((p) => p.id).join(',')}`).join('|')

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const to = e.over?.data.current as DropTarget | undefined
    if (to && e.active.id) move(e.active.id as PanelId, to)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={(e) => setDragging(e.active.id as PanelId)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <PanelGroup key={shape} direction="horizontal" className={`desk${editing ? ' desk--editing' : ''}`} onLayout={setWidths}>
        {columns.map((col, i) => (
          <Column key={col.id} col={col} order={i} last={i === columns.length - 1} editing={editing} dragging={dragging} panels={panels} onSizes={(sizes) => setSizes(col.id, sizes)} />
        ))}
      </PanelGroup>
      <DragOverlay dropAnimation={null}>{dragging && <div className="desk-ghost">{PANEL_LABEL[dragging]}</div>}</DragOverlay>
      {editing && <LayoutBar />}
    </DndContext>
  )
}

function Column({
  col,
  order,
  last,
  editing,
  dragging,
  panels,
  onSizes,
}: {
  col: LayoutColumn
  order: number
  last: boolean
  editing: boolean
  dragging: PanelId | null
  panels: Record<PanelId, ReactNode>
  onSizes: (sizes: number[]) => void
}) {
  return (
    <>
      <Panel id={col.id} order={order} defaultSize={col.width} minSize={10} className="desk__col">
        {dragging && <EdgeDrop column={col.id} side="left" />}
        <PanelGroup direction="vertical" onLayout={onSizes}>
          {col.panels.map((p, j) => (
            <PanelSlot key={p.id} id={p.id} order={j} size={p.size} last={j === col.panels.length - 1} editing={editing} dragging={dragging}>
              {panels[p.id]}
            </PanelSlot>
          ))}
        </PanelGroup>
        {dragging && <EdgeDrop column={col.id} side="right" />}
      </Panel>
      {!last && <PanelResizeHandle className="desk__gutter desk__gutter--col" />}
    </>
  )
}

function PanelSlot({ id, order, size, last, editing, dragging, children }: { id: PanelId; order: number; size: number; last: boolean; editing: boolean; dragging: PanelId | null; children: ReactNode }) {
  const drag = useDraggable({ id, disabled: !editing })
  return (
    <>
      <Panel id={id} order={order} defaultSize={size} minSize={8} className={`desk__panel desk__panel--${id}${drag.isDragging ? ' is-dragged' : ''}`}>
        {children}
        {editing && (
          <div className="desk__edit">
            <button className="desk__handle" ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} aria-label={`Move ${PANEL_LABEL[id]}`}>
              <LuGripVertical /> {PANEL_LABEL[id]}
            </button>
            {dragging && dragging !== id && (
              <>
                <SideDrop panel={id} side="above" />
                <SideDrop panel={id} side="below" />
              </>
            )}
          </div>
        )}
      </Panel>
      {!last && <PanelResizeHandle className="desk__gutter desk__gutter--row" />}
    </>
  )
}

/** The top or bottom half of a panel: drop here to go above / below it. */
function SideDrop({ panel, side }: { panel: PanelId; side: 'above' | 'below' }) {
  const target: DropTarget = { panel, side }
  const { setNodeRef, isOver } = useDroppable({ id: `p:${panel}:${side}`, data: target })
  return <div ref={setNodeRef} className={`desk__drop desk__drop--${side}${isOver ? ' is-over' : ''}`} />
}

/** A column's left or right edge: drop here for a new column on that side. */
function EdgeDrop({ column, side }: { column: string; side: 'left' | 'right' }) {
  const target: DropTarget = { column, side }
  const { setNodeRef, isOver } = useDroppable({ id: `c:${column}:${side}`, data: target })
  return <div ref={setNodeRef} className={`desk__edge desk__edge--${side}${isOver ? ' is-over' : ''}`} />
}

/** Layout mode's own bar: back to the default arrangement, or done. */
function LayoutBar() {
  const { reset, setEditing } = useLayout()
  return (
    <div className="desk-bar" role="toolbar" aria-label="Layout">
      <span>Drag a panel by its handle: onto another panel's top or bottom half, or to a column's edge for a new column. Drag the gaps to resize.</span>
      <button className="small" onClick={reset}>
        <LuRotateCcw /> Reset
      </button>
      <button className="small primary" onClick={() => setEditing(false)}>
        <LuCheck /> Done
      </button>
    </div>
  )
}
