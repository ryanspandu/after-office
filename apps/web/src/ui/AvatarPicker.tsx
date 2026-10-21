import { useState } from 'react'
import { LuCheck, LuChevronDown, LuWandSparkles } from 'react-icons/lu'
import { avatarStyle, type OfficeAgent } from '../state/store'
import { AgentFace, MAN, WOMAN } from './AgentFace'

// An agent's profile → Overview: its avatar, and the others it can have (its figure's hair, drawn with its own face,
// glasses and colour). "Auto" goes back to the one drawn from its look.

export function AvatarPicker({ agent, onPick }: { agent: OfficeAgent; onPick: (face: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const choices = agent.look.figure === 'woman' ? WOMAN : MAN
  const auto = { ...agent.look, face: undefined }
  return (
    <div className="avatar-pick">
      <button type="button" className="avatar-pick__current" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar avatar--lg" style={avatarStyle(agent.look.shirt)}>
          <AgentFace look={agent.look} />
        </span>
        <span>{agent.look.face ? 'Chosen avatar' : 'Automatic avatar'}</span>
        <LuChevronDown className={`avatar-pick__chev${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="avatar-pick__grid ui-pop" role="listbox" aria-label="Avatars">
          <button
            type="button"
            role="option"
            aria-selected={!agent.look.face}
            className={`avatar-pick__opt${!agent.look.face ? ' is-on' : ''}`}
            data-tip="Automatic: from its character's look"
            onClick={() => onPick(null)}
          >
            <span className="avatar" style={avatarStyle(agent.look.shirt)}>
              <AgentFace look={auto} />
            </span>
            <span className="avatar-pick__auto" aria-hidden>
              <LuWandSparkles />
            </span>
          </button>
          {choices.map((face) => {
            const on = agent.look.face === face
            return (
              <button key={face} type="button" role="option" aria-selected={on} aria-label={face} className={`avatar-pick__opt${on ? ' is-on' : ''}`} onClick={() => onPick(face)}>
                <span className="avatar" style={avatarStyle(agent.look.shirt)}>
                  <AgentFace look={{ ...agent.look, face }} />
                </span>
                {on && (
                  <span className="avatar-pick__auto" aria-hidden>
                    <LuCheck />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
