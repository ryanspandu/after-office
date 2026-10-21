import { useEffect } from 'react'
import { LuChevronDown, LuChevronUp, LuLocateFixed, LuMessageSquare, LuMinus, LuPlus, LuRotate3D, LuRotateCcw, LuRotateCw, LuSearch, LuX } from 'react-icons/lu'
import { useView } from '../scene/focus'
import { useDashboard } from '../state/dashboard'
import { avatarStyle, useOffice } from '../state/store'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { activityOf } from './agentActivity'
import { STATUS_META } from './AgentsPanel'
import { tip } from './Tooltip'
import { AgentFace } from './AgentFace'

// A clicked agent in the office: the camera follows it (scene/Office.tsx FocusCamera) and this card says who it is and
// what it's doing, with its chat a click away. ✕, Esc or a click on empty floor lets it go (the camera goes back).

export function FocusCard() {
  const agent = useOffice((s) => s.agents.find((a) => a.id === s.selectedId))
  const select = useOffice((s) => s.select)
  const openProfile = useOffice((s) => s.openProfile)
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent) => {
      // a window open over the office has Esc for itself
      if (e.key !== 'Escape' || document.querySelector('.modal-backdrop:not(.modal-backdrop--closing), .drawer-backdrop')) return
      select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agent, select])
  if (!agent) return null
  const status = agent.status === 'waiting' ? 'waiting' : agent.status
  return (
    <div className="focus-card" role="dialog" aria-label={agent.name}>
      <span className="avatar" style={avatarStyle(agent.look.shirt)}>
        <AgentFace look={agent.look} />
      </span>
      <span className="focus-card__text">
        <span className="focus-card__name">
          {agent.name}
          <span className={`status status--${status}`}>{STATUS_META[agent.status].label}</span>
        </span>
        <span className="focus-card__doing">{activityOf(agent)}</span>
        <span className="focus-card__role muted">{agent.role || agent.profile.role || (agent.kind === 'manager' ? 'Manager' : 'Agent')}</span>
      </span>
      <button className="small primary focus-card__chat" onClick={() => openProfile(agent.id)}>
        <LuMessageSquare /> Chat
      </button>
      <button className="icon-btn small ghost" {...tip('Back to the whole office (Esc)')} onClick={() => select(null)}>
        <LuX />
      </button>
    </div>
  )
}

/**
 * The camera's buttons on the stage: turn the view left or right, zoom in or out, and (once it was moved) back to the
 * whole office as it opened. The same as dragging with the right button / two fingers and scrolling / pinching.
 */
export function ViewReset() {
  const moved = useView((s) => s.moved)
  const reset = useView((s) => s.reset)
  const turn = useView((s) => s.turn)
  const zoomBy = useView((s) => s.zoomBy)
  const tilt = useView((s) => s.tilt)
  const pinch = useView((s) => s.pinch)
  const setPinch = useView((s) => s.setPinch)
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)')
  const select = useOffice((s) => s.select)
  // tips point in, toward the stage's middle: the buttons sit on its right edge, on the left in the desktop's
  // fullscreen office (styles/stage-dock.css)
  const fullscreen = useDashboard((s) => s.fullscreen)
  const mobile = useMediaQuery(MOBILE)
  const side = fullscreen && !mobile ? 'right' : 'left'
  return (
    <div className="view-controls" role="toolbar" aria-label="Camera">
      <button {...tip('Turn left', side)} onClick={() => turn(-Math.PI / 4)}>
        <LuRotateCcw />
      </button>
      <button {...tip('Turn right', side)} onClick={() => turn(Math.PI / 4)}>
        <LuRotateCw />
      </button>
      <button {...tip('Look from lower down', side)} onClick={() => tilt(0.25)}>
        <LuChevronDown />
      </button>
      <button {...tip('Look from higher up', side)} onClick={() => tilt(-0.25)}>
        <LuChevronUp />
      </button>
      <span className="view-controls__sep" />
      <button {...tip('Zoom in', side)} onClick={() => zoomBy(1.35)}>
        <LuPlus />
      </button>
      <button {...tip('Zoom out', side)} onClick={() => zoomBy(1 / 1.35)}>
        <LuMinus />
      </button>
      {/* touch screens: what two fingers do, zoom or turn (one at a time) */}
      {touch && (
        <>
          <span className="view-controls__sep" />
          <button
            className={`view-controls__pinch view-controls__pinch--${pinch}`}
            aria-label={pinch === 'zoom' ? 'Two fingers zoom: switch to turning' : 'Two fingers turn: switch to zooming'}
            onClick={() => setPinch(pinch === 'zoom' ? 'turn' : 'zoom')}
          >
            {pinch === 'zoom' ? <LuSearch /> : <LuRotate3D />}
          </button>
        </>
      )}
      {moved && (
        <>
          <span className="view-controls__sep" />
          <button
            {...tip('Back to the whole office', side)}
            onClick={() => {
              select(null)
              reset()
            }}
          >
            <LuLocateFixed />
          </button>
        </>
      )}
    </div>
  )
}
