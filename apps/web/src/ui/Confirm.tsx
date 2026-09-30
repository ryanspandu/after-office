import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LuTrash2, LuTriangleAlert } from 'react-icons/lu'
import { create } from 'zustand'
import { Modal } from './Modal'

// One confirmation dialog for the whole app: deleting, removing, signing out. `confirm()` opens it and resolves
// with the answer, so a button can simply `if (!(await confirm({...}))) return`.

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  /** default "Delete" */
  confirmLabel?: string
  /** red button and warning icon (default true) */
  danger?: boolean
  /** an extra choice shown as a checkbox (off by default), e.g. "Also delete its folder" */
  option?: { label: ReactNode; hint?: ReactNode }
}

interface Pending extends ConfirmOptions {
  resolve: (r: { ok: boolean; option: boolean }) => void
}

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }))

/** Ask first; resolves with ok (and the checkbox, if there was one). */
export function confirmWith(opts: ConfirmOptions): Promise<{ ok: boolean; option: boolean }> {
  // a second question replaces the first, which counts as cancelled
  useConfirmStore.getState().pending?.resolve({ ok: false, option: false })
  return new Promise((resolve) => useConfirmStore.setState({ pending: { ...opts, resolve } }))
}

export const confirm = async (opts: ConfirmOptions) => (await confirmWith(opts)).ok

export function ConfirmLayer() {
  const pending = useConfirmStore((s) => s.pending)
  const [option, setOption] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setOption(false)
    // keyboard: Enter confirms right away; Esc (Modal) cancels
    if (pending) setTimeout(() => confirmRef.current?.focus(), 30)
  }, [pending])
  if (!pending) return null
  const danger = pending.danger !== false
  const answer = (ok: boolean) => {
    pending.resolve({ ok, option: ok && option })
    useConfirmStore.setState({ pending: null })
  }
  return (
    <Modal open onClose={() => answer(false)} title={pending.title} width={420}>
      <div className="modal__body confirm-modal">
        <div className="confirm-modal__text">
          {danger && <LuTriangleAlert className="confirm-modal__icon" />}
          <div>{pending.message ?? <span className="muted">This can't be undone.</span>}</div>
        </div>
        {pending.option && (
          <label className="confirm-modal__option">
            <input className="check" type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
            <span>
              {pending.option.label}
              {pending.option.hint && <span className="field__hint">{pending.option.hint}</span>}
            </span>
          </label>
        )}
        <footer className="modal__foot">
          <button onClick={() => answer(false)}>Cancel</button>
          <button ref={confirmRef} className={danger ? 'danger-solid' : 'primary'} onClick={() => answer(true)}>
            {danger && <LuTrash2 />} {pending.confirmLabel ?? 'Delete'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
