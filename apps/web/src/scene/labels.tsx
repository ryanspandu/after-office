import { useCallback, type ReactNode } from 'react'
import { LuCat, LuCircleAlert, LuCircleDot, LuClipboardCheck, LuCrown, LuCoffee, LuHeart, LuKeyboard, LuMessageCircle, LuSandwich, LuTv } from 'react-icons/lu'
import { Vector3, type Camera } from 'three'
import { useLive } from '../state/live'
import { useOffice } from '../state/store'

// Name tags live in one plain DOM overlay above the canvas. Scene objects move them each frame via
// `placeLabel`, which avoids creating a React root per tag (what drei's <Html> does).

const els = new Map<string, HTMLDivElement>()
const v = new Vector3()

/** Project a world point to the canvas and move the label there. Hidden if not registered. */
export function placeLabel(id: string, world: Vector3, camera: Camera, width: number, height: number) {
  const el = els.get(id)
  if (!el) return null
  v.copy(world).project(camera)
  const x = (v.x * 0.5 + 0.5) * width
  const y = (-v.y * 0.5 + 0.5) * height
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
  // keep nearer (lower on screen) labels on top; the selected agent's tag above everything
  el.style.zIndex = el.classList.contains('tag--selected') ? '100000' : String(Math.round(y))
  return el
}

function useRegister(id: string) {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el) els.set(id, el)
      else els.delete(id)
    },
    [id],
  )
}

/** Icon shown above an agent per pose; the agent sets `data-pose` on its tag each frame and CSS picks the icon. */
const POSE_ICONS: [pose: string, icon: ReactNode][] = [
  ['type', <LuKeyboard />],
  ['wait', <LuCircleAlert />],
  ['meeting', <LuMessageCircle />],
  ['sofa', <LuTv />],
  ['relax', <LuCoffee />],
  ['eat', <LuSandwich />],
  ['pet', <LuCat />],
  ['billiards', <LuCircleDot />],
]

function AgentTag({ id }: { id: string }) {
  const agent = useOffice((s) => s.departing.find((a) => a.id === id) ?? s.agents.find((a) => a.id === id))
  const selected = useOffice((s) => s.selectedId === id)
  // someone else is selected: step back so the selected agent stands out
  const dimmed = useOffice((s) => s.selectedId !== null && s.selectedId !== id)
  const briefed = useLive((s) => (s.briefings[id] ?? 0) > Date.now())
  const ref = useRegister(id)
  if (!agent) return null
  return (
    <div ref={ref} className={`tag tag--${agent.status}${selected ? ' tag--selected' : ''}${dimmed ? ' tag--dimmed' : ''}${briefed ? ' tag--briefed' : ''}`}>
      {briefed && (
        <div className="tag__briefing" aria-label="New task from the manager">
          <LuClipboardCheck />
        </div>
      )}
      <div className="tag__bubble">
        {POSE_ICONS.map(([pose, icon]) => (
          <span key={pose} data-icon={pose}>
            {icon}
          </span>
        ))}
      </div>
      <div className="tag__name">
        {agent.kind === 'manager' ? <LuCrown className="tag__crown" /> : <span className="tag__dot" style={{ background: agent.look.shirt }} />}
        {agent.name}
      </div>
    </div>
  )
}

function CatTag() {
  const ref = useRegister('cat')
  const dimmed = useOffice((s) => s.selectedId !== null)
  return (
    <div ref={ref} className={`tag${dimmed ? ' tag--dimmed' : ''}`}>
      <div className="cat-hearts">
        <LuHeart />
      </div>
    </div>
  )
}

export function LabelLayer() {
  // departing agents keep their tag until they've driven off
  const ids = useOffice((s) => [...s.agents.filter((a) => a.status !== 'offline'), ...s.departing].map((a) => a.id).join(','))
  return (
    <div className="labels">
      <CatTag />
      {ids && ids.split(',').map((id) => <AgentTag key={id} id={id} />)}
    </div>
  )
}
