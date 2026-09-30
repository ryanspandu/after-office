import { LuSparkles } from 'react-icons/lu'
import { useQuality } from '../scene/quality'
import { tip } from './Tooltip'

/** "Advanced render" switch on the 3D stage: every lamp becomes a real light, sharper shadows. Off by default. */
export function RenderSwitch() {
  const advanced = useQuality((s) => s.advanced)
  const setAdvanced = useQuality((s) => s.setAdvanced)
  return (
    <label
      className={`render-switch${advanced ? ' render-switch--on' : ''}`}
      {...tip(advanced ? 'Advanced render: real lamp lights and sharp shadows (heavier)' : 'Turn on real lamp lights and sharp shadows (heavier on older devices)')}
    >
      <LuSparkles />
      <span className="render-switch__label">Advanced render</span>
      <span className="toggle">
        <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} aria-label="Advanced render" />
        <span />
      </span>
    </label>
  )
}
