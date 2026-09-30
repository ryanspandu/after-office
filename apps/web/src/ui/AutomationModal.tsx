import { useState } from 'react'
import { BossModeSwitch } from './BossMode'
import { NotifyChannels } from './NotifyChannels'
import { LuBell, LuBellRing, LuCircleCheck, LuCircleX, LuSend, LuUserRound } from 'react-icons/lu'
import { useProfileModal } from './ProfileModal'
import { create } from 'zustand'
import type { NotifyEvent, OfficeSettings } from '@after-office/shared'
import { liveApi, useLive } from '../state/live'
import { useOffice } from '../state/store'
import { chime, useReplyAlerts } from '../state/replyAlerts'
import { Modal } from './Modal'

// Office automation: push notifications to your phone, and the quota brake that holds automatic work (auto-start,
// cron, the manager's new tasks) when the Claude plan is nearly used up. Channels hold secrets, so they are set in
// the server's .env; everything else is here.

export const useAutomationModal = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

const EVENTS: { id: NotifyEvent; label: string; hint: string }[] = [
  { id: 'permission', label: 'An agent needs you', hint: 'permission prompts, questions, plans to approve' },
  { id: 'review', label: 'Work ready for review', hint: 'an agent finished (or gave up on) a task' },
  { id: 'cronFailed', label: 'Daily run failed or skipped', hint: '' },
  { id: 'managerNote', label: 'Notes from the manager', hint: 'what the manager flags with notify_user' },
  { id: 'quota', label: 'Quota brake on / off', hint: '' },
  { id: 'stuck', label: 'Stuck work', hint: 'an agent went offline mid-task, or went quiet for 30 min' },
  { id: 'security', label: 'Security', hint: "an agent's hooks were changed (and put back)" },
]

/** Navbar button (desktop). Shows a dot while the quota brake holds work. */
export function AutomationButton() {
  const live = useOffice((s) => s.source === 'live')
  const paused = useLive((s) => s.automation.quotaPaused)
  const setOpen = useAutomationModal((s) => s.setOpen)
  if (!live) return null
  return (
    <button
      className={`icon-btn icon-btn--badge${paused ? ' automation-btn--paused' : ''}`}
      data-tip={paused ? `Automatic work paused: ${paused}` : 'Notifications & quota brake'}
      aria-label="Notifications and quota brake"
      onClick={() => setOpen(true)}
    >
      {paused ? <LuBellRing /> : <LuBell />}
      {paused && <span className="icon-btn__dot" />}
    </button>
  )
}

export function AutomationModal() {
  const open = useAutomationModal((s) => s.open)
  const setOpen = useAutomationModal((s) => s.setOpen)
  const settings = useLive((s) => s.settings)
  const { channels, quotaPaused } = useLive((s) => s.automation)
  const rl = useLive((s) => s.rateLimits)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const sound = useReplyAlerts((s) => s.sound)
  const [tested, setTested] = useState<{ channel: string; ok: boolean; error?: string }[] | null>(null)
  if (!settings) return null

  // optimistic: the server echoes the saved settings back over SSE
  const save = (patch: {
    notify?: Partial<OfficeSettings['notify']>
    quota?: Partial<OfficeSettings['quota']>
    managerApproval?: boolean
    autoAssign?: boolean
    notifyDetail?: OfficeSettings['notifyDetail']
  }) => {
    setError(null)
    useLive.setState({
      settings: {
        notify: { ...settings.notify, ...patch.notify },
        quota: { ...settings.quota, ...patch.quota },
        managerApproval: patch.managerApproval ?? settings.managerApproval,
        notifyDetail: patch.notifyDetail ?? settings.notifyDetail,
        autoAssign: patch.autoAssign ?? settings.autoAssign,
      },
    })
    liveApi.saveAutomation(patch).catch((e) => setError(e.message))
  }

  const test = async () => {
    setTesting(true)
    setTested(null)
    setError(null)
    try {
      setTested((await liveApi.testNotifications()).results)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const q = settings.quota
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Automation" description="Push notifications and the quota brake" width={520}>
      <div className="modal__body automation">
        <section className="automation__section">
          <h4>Notifications</h4>
          <NotifyChannels onChanged={() => setTested(null)} />
          {channels.length > 0 && (
            <p className="muted automation__channels">
              Sending to <b>{channels.join(', ')}</b>.
              <button className="small" onClick={test} disabled={testing}>
                <LuSend /> {testing ? 'Sending…' : 'Send test'}
              </button>
            </p>
          )}
          {tested && (
            <ul className="automation__tested">
              {tested.map((t) => (
                <li key={t.channel} className={t.ok ? 'ok' : 'bad'}>
                  {t.ok ? <LuCircleCheck /> : <LuCircleX />} {t.channel}
                  {t.error ? `: ${t.error}` : ': sent'}
                </li>
              ))}
            </ul>
          )}
          <label className="switch-row">
            <span className="toggle">
              <input type="checkbox" role="switch" checked={settings.notifyDetail === 'full'} onChange={(ev) => save({ notifyDetail: ev.target.checked ? 'full' : 'minimal' })} />
              <span />
            </span>
            <span>
              <span className="switch-row__label">Include details</span>
              <span className="field__hint">
                Commands and report text in the push. Off: only what happened, nothing else leaves the server (safer with a public ntfy topic).
              </span>
            </span>
          </label>
          <label className="switch-row">
            <span className="toggle">
              <input
                type="checkbox"
                role="switch"
                checked={sound}
                onChange={(ev) => {
                  useReplyAlerts.getState().setSound(ev.target.checked)
                  if (ev.target.checked) chime()
                }}
              />
              <span />
            </span>
            <span>
              <span className="switch-row__label">Sound when an agent replies</span>
              <span className="field__hint">A short chime in this browser, also while that chat is open. Saved on this device.</span>
            </span>
          </label>
          <div className="automation__list">
            {EVENTS.map((e) => (
              <label key={e.id} className="switch-row">
                <span className="toggle">
                  <input type="checkbox" role="switch" checked={settings.notify[e.id]} onChange={(ev) => save({ notify: { [e.id]: ev.target.checked } })} />
                  <span />
                </span>
                <span>
                  <span className="switch-row__label">{e.label}</span>
                  {e.hint && <span className="field__hint">{e.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="automation__section">
          <h4>Quota brake</h4>
          <label className="switch-row">
            <span className="toggle">
              <input type="checkbox" role="switch" checked={q.enabled} onChange={(ev) => save({ quota: { enabled: ev.target.checked } })} />
              <span />
            </span>
            <span>
              <span className="switch-row__label">Hold automatic work near the plan limit</span>
              <span className="field__hint">Auto-start, tasks waiting on others, daily runs and the manager's new tasks wait. Daily runs in that time are skipped.</span>
            </span>
          </label>
          <label className={`automation__threshold${q.enabled ? '' : ' is-off'}`}>
            <span>
              Brake at <b>{q.threshold}%</b> of the 5-hour or weekly limit
            </span>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={q.threshold}
              disabled={!q.enabled}
              onChange={(ev) => useLive.setState({ settings: { ...settings, quota: { ...q, threshold: Number(ev.target.value) } } })}
              onPointerUp={(ev) => save({ quota: { threshold: Number((ev.target as HTMLInputElement).value) } })}
              onKeyUp={(ev) => save({ quota: { threshold: Number((ev.target as HTMLInputElement).value) } })}
              aria-label="Brake threshold"
            />
          </label>
          <p className={`automation__state${quotaPaused ? ' is-paused' : ''}`}>
            {quotaPaused
              ? `Paused now: ${quotaPaused}. Held work starts on its own when usage drops. Anything you start by hand still runs.`
              : rl?.fiveHourPct != null
                ? `Running. Now at ${Math.round(rl.fiveHourPct)}% (5-hour)${rl.sevenDayPct != null ? ` and ${Math.round(rl.sevenDayPct)}% (weekly)` : ''}.`
                : 'Running. Usage shows up after an agent replies.'}
          </p>
        </section>
        <section className="automation__section">
          <h4>Manager &amp; hand-offs</h4>
          <label className="switch-row">
            <span className="toggle">
              <input type="checkbox" role="switch" checked={settings.managerApproval} onChange={(ev) => save({ managerApproval: ev.target.checked })} />
              <span />
            </span>
            <span>
              <span className="switch-row__label">Approve the manager's tasks first</span>
              <span className="field__hint">New tasks from the manager wait in "Needs your attention" until you approve or reject them.</span>
            </span>
          </label>
          <BossModeSwitch />
          <label className="switch-row">
            <span className="toggle">
              <input type="checkbox" role="switch" checked={settings.autoAssign} onChange={(ev) => save({ autoAssign: ev.target.checked })} />
              <span />
            </span>
            <span>
              <span className="switch-row__label">Hand out tasks without an agent</span>
              <span className="field__hint">
                Auto-start tasks with no agent go to the manager to staff, or, without a manager, to an agent who is free.
              </span>
            </span>
          </label>
        </section>
        <section className="automation__section">
          <h4>Security</h4>
          <div className="automation__signout">
            <span className="field__hint">Signed-in devices, sign-in history and signing devices out are in your profile.</span>
            <button
              className="small"
              onClick={() => {
                setOpen(false)
                useProfileModal.getState().setOpen(true)
              }}
            >
              <LuUserRound /> Open profile
            </button>
          </div>
        </section>
        {error && <div className="row__error">{error}</div>}
      </div>
    </Modal>
  )
}
