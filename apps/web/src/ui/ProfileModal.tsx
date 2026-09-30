import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LuCircleCheck, LuCircleX, LuEllipsisVertical, LuInfo, LuKeyRound, LuLogOut, LuMonitor, LuRefreshCw, LuSettings2, LuShieldCheck, LuUserPen, LuSmartphone, LuTablet } from 'react-icons/lu'
import { create } from 'zustand'
import { describeUserAgent, type LoginEvent, type SessionInfo } from '@after-office/shared'
import { api, useAuth } from '../state/auth'
import { useNow } from '../state/clock'
import { ago } from './FollowUps'
import { Modal } from './Modal'
import { confirm } from './Confirm'
import { tip } from './Tooltip'
import { openUrl } from '../state/url'
import { OwnerAvatar } from './EditProfile'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'

// Profile: who is signed in, on which devices, and the recent sign-in attempts (successful or not).

export const useProfileModal = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** "Chrome on macOS" and a device kind, from a user agent (shared with the server's activity log). */
export const describeAgent = describeUserAgent

const KindIcon = ({ kind }: { kind: 'phone' | 'tablet' | 'desktop' }) => (kind === 'phone' ? <LuSmartphone /> : kind === 'tablet' ? <LuTablet /> : <LuMonitor />)

const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export function ProfileModal() {
  const open = useProfileModal((s) => s.open)
  const setOpen = useProfileModal((s) => s.setOpen)
  const user = useAuth((s) => s.user)
  const twoFactor = useAuth((s) => s.twoFactor)
  const logout = useAuth((s) => s.logout)
  const mobile = useMediaQuery(MOBILE)
  const now = useNow(60_000).getTime()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [log, setLog] = useState<LoginEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<LoginEvent | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api('/api/auth/sessions')
      if (!res.ok) throw new Error(`Could not load your devices (${res.status})`)
      const body = (await res.json()) as { sessions: SessionInfo[]; log: LoginEvent[] }
      setSessions(body.sessions)
      setLog(body.log)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const revoke = async (s: SessionInfo) => {
    if (s.current) return void logout()
    setBusy(s.id)
    await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {})
    setBusy(null)
    void load()
  }
  const signOutOthers = async () => {
    if (!(await confirm({ title: 'Sign out on every other device?', message: 'Every other browser and phone signed in to After Office has to sign in again. This one stays signed in.', confirmLabel: 'Sign out others', danger: false }))) return
    setBusy('others')
    await api('/api/auth/logout-others', { method: 'POST', body: '{}' }).catch(() => {})
    setBusy(null)
    void load()
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Profile" width={620}>
      <div className="modal__body profile">
        <div className="profile__who">
          <OwnerAvatar className="profile__avatar" />
          <div className="grow">
            <b>{user}</b>
            <span className="muted">Owner of this office</span>
          </div>
          {mobile ? (
            // phones: one button, the three actions in a menu
            <ProfileMenu
              items={[
                { icon: <LuUserPen />, label: 'Edit profile', onClick: () => openUrl({ editprofile: 1 }) },
                { icon: <LuSettings2 />, label: 'Project settings', onClick: () => openUrl({ settings: 1 }) },
                { icon: <LuKeyRound />, label: 'Change password', onClick: () => openUrl({ password: 1 }) },
                { icon: <LuShieldCheck />, label: 'Two-factor', onClick: () => openUrl({ twofa: 1 }) },
                { icon: <LuLogOut />, label: 'Sign out', onClick: logout },
              ]}
            />
          ) : (
            <>
              <button className="small" onClick={() => openUrl({ editprofile: 1 })} {...tip('Your picture and username')}>
                <LuUserPen /> Edit profile
              </button>
              <button className="small" onClick={() => openUrl({ settings: 1 })} {...tip("The office's name, description and logo")}>
                <LuSettings2 /> Project settings
              </button>
              <button className="small" onClick={logout}>
                <LuLogOut /> Sign out
              </button>
            </>
          )}
        </div>

        {!mobile && (
          // sign-in security, under the header (on phones: in the ⋮ menu)
          <section className="profile__section">
            <header className="profile__head">
              <h4>Security</h4>
            </header>
            <div className="profile__security">
              <button className="profile__sec-btn" onClick={() => openUrl({ password: 1 })}>
                <LuKeyRound />
                <span>
                  <b>Change password</b>
                  <span className="muted">Other devices are signed out afterwards</span>
                </span>
              </button>
              <button className="profile__sec-btn" onClick={() => openUrl({ twofa: 1 })}>
                <LuShieldCheck />
                <span>
                  <b>Two-factor</b>
                  <span className="muted">
                    {twoFactor?.enrolled ? `On · ${twoFactor.recoveryLeft ?? 0} recovery code${twoFactor.recoveryLeft === 1 ? '' : 's'} left` : 'A new phone, new recovery codes'}
                  </span>
                </span>
              </button>
            </div>
          </section>
        )}

        <section className="profile__section">
          <header className="profile__head">
            <h4>Signed-in devices</h4>
            <button className="icon-btn small ghost" data-tip="Refresh" aria-label="Refresh" onClick={() => void load()}>
              <LuRefreshCw />
            </button>
          </header>
          {error && <div className="row__error">{error}</div>}
          {!sessions ? (
            <div className="muted">Loading…</div>
          ) : (
            <ul className="profile__list">
              {sessions.map((s) => {
                const d = describeAgent(s.agent)
                return (
                  <li key={s.id} className={`profile__device${s.current ? ' is-current' : ''}`}>
                    <span className="profile__icon">
                      <KindIcon kind={d.kind} />
                    </span>
                    <div className="profile__body">
                      <span className="profile__title">
                        {/* one line: a long device name is cut short (whole name in the tooltip), the badge stays whole */}
                        <span className="truncate" data-tip={d.label}>
                          {d.label}
                        </span>
                        {s.current && <span className="profile__badge">This device</span>}
                      </span>
                      <span className="muted profile__meta" data-tip={s.agent}>
                        {s.ip || 'unknown IP'} · {s.current ? 'active now' : `active ${ago(now - s.lastSeenAt)}`} · signed in {when(s.createdAt)}
                      </span>
                    </div>
                    <button className="small" disabled={busy === s.id} onClick={() => void revoke(s)}>
                      Sign out
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {others > 0 && (
            <button className="small danger-solid profile__others" disabled={busy === 'others'} onClick={() => void signOutOthers()}>
              <LuLogOut /> Sign out {others} other device{others === 1 ? '' : 's'}
            </button>
          )}
        </section>

        <section className="profile__section">
          <header className="profile__head">
            <h4>Recent sign-ins</h4>
          </header>
          {!log.length ? (
            <div className="muted">No sign-ins recorded yet.</div>
          ) : (
            <ul className="profile__list profile__log">
              {log.map((e, i) => {
                const d = describeAgent(e.agent)
                return (
                  <li key={i} className={e.ok ? '' : 'is-failed'}>
                    {e.ok ? <LuCircleCheck className="profile__ok" /> : <LuCircleX className="profile__fail" />}
                    <span className="grow truncate">
                      {signInLabel(e)}
                      {e.username ? ` as “${e.username}”` : ''} · {d.label}
                    </span>
                    <span className="muted profile__meta">
                      {e.ip} · {ago(now - e.at)}
                    </span>
                    <button className="icon-btn small ghost" aria-label="Sign-in details" onClick={() => setDetail(e)}>
                      <LuInfo />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="field__hint">Don't recognise a device or a sign-in? Sign it out and change your password (`bun run auth:setup` on the server).</p>
        </section>
        {detail && <SignInDetail e={detail} onClose={() => setDetail(null)} />}
      </div>
    </Modal>
  )
}

/** What a sign-in entry was: which step, and whether it worked. */
function signInLabel(e: LoginEvent) {
  if (e.ok) return e.step === 'recovery' ? 'Signed in with a recovery code' : e.step === 'code' ? 'Signed in' : e.step === 'password' ? 'Password right (2FA setup)' : 'Signed in'
  return e.step === 'code' ? 'Wrong 2FA code' : e.step === 'recovery' ? 'Wrong recovery code' : 'Wrong password'
}

/** Everything recorded about one sign-in attempt. */
function SignInDetail({ e, onClose }: { e: LoginEvent; onClose: () => void }) {
  const d = describeAgent(e.agent)
  const rows: [string, string][] = [
    ['Result', signInLabel(e)],
    ['When', new Date(e.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })],
    ['Step', e.step === 'code' ? 'Password, then the authenticator code' : e.step === 'recovery' ? 'Password, then a recovery code' : e.step === 'password' ? 'Password' : 'Not recorded (older entry)'],
    ...(e.username ? ([['Username tried', e.username]] as [string, string][]) : []),
    ['IP address', e.ip || 'unknown'],
    ['Device', d.label],
  ]
  return (
    <Modal open onClose={onClose} title="Sign-in details" width={480}>
      <div className="modal__body signin-detail">
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === 'Result' && !e.ok ? 'danger-text' : ''}>{v}</dd>
            </div>
          ))}
          <div>
            <dt>Browser (user agent)</dt>
            <dd>
              <code>{e.agent || 'unknown'}</code>
            </dd>
          </div>
        </dl>
        {!e.ok && <p className="field__hint">Not you? Nothing got in: this attempt failed. Many of them from one IP lock it out for a while.</p>}
        <footer className="modal__foot">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  )
}

/** A "⋮" button with a small menu under it (the Profile's actions on phones). Closes on a pick, a click elsewhere, or Esc. */
function ProfileMenu({ items }: { items: { icon: ReactNode; label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // the menu closes, not the whole Profile
      setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])
  return (
    <div className="pmenu" ref={box}>
      <button className={`icon-btn${open ? ' is-on' : ''}`} aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <LuEllipsisVertical />
      </button>
      {open && (
        <div className="pmenu__list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className="pmenu__item"
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
