import type { ReactNode } from 'react'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'

/** A dock panel as a bottom sheet, with a button to give it the whole screen (remembered per panel). */
export function DockSheet({ open, onClose, title, bodyClass = 'dock-sheet', children }: { open: boolean; onClose: () => void; title: string; bodyClass?: string; children: ReactNode }) {
  const max = useModalMaximize(560, `after-office:sheet-max:${title}`)
  return (
    <Modal open={open} onClose={onClose} title={title} {...max.modalProps}>
      <div className={`modal__body ${bodyClass}`} ref={max.bodyRef}>
        {children}
      </div>
    </Modal>
  )
}
