import { AutomationModal } from './ui/AutomationModal'
import { ProfileModal } from './ui/ProfileModal'
import { ConfirmLayer } from './ui/Confirm'
import { UrlModals } from './ui/UrlModals'
import { useEffect } from 'react'
import { LuMessageSquareText, LuRefreshCw, LuTriangleAlert, LuX } from 'react-icons/lu'
import { useAppUpdate } from './pwa/register'
import { useLaunch } from './pwa/launch'
import { LabelLayer } from './scene/labels'
import { Office } from './scene/Office'
import { useCronRunner } from './state/cronRunner'
import { useDashboard } from './state/dashboard'
import { useLiveSync } from './state/live'
import { useReplyAlerts, useReplyAlertWatcher } from './state/replyAlerts'
import { useOffice } from './state/store'
import { useMetricsSim, useMockSim } from './state/mockSim'
import { MOBILE, useMediaQuery } from './state/useMediaQuery'
import { AgentProfileDrawer } from './ui/AgentProfile'
import { AgentsPanel } from './ui/AgentsPanel'
import { FollowUps } from './ui/FollowUps'
import { LeftSidebar } from './ui/LeftSidebar'
import { ManagerPanel, useManager, useManagerPanel } from './ui/ManagerPanel'
import { Navbar } from './ui/Navbar'
import { RenderSwitch } from './ui/RenderSwitch'
import { AppReload } from './ui/AppReload'
import { MobileDock } from './ui/MobileDock'

export function App() {
  useLiveSync()
  useMockSim()
  useMetricsSim()
  useCronRunner()
  useReplyAlertWatcher()
  const replied = useReplyAlerts((s) => s.toast)
  const fullscreen = useDashboard((s) => s.fullscreen)
  const syncError = useDashboard((s) => s.syncError)
  // phones: the office fills the screen; the side panels open from a floating dock
  const mobile = useMediaQuery(MOBILE)
  const update = useAppUpdate()
  // app shortcut "Manager chat": open the manager's panel once the manager is known (live data arrives first)
  const launch = useLaunch((s) => s.open)
  const manager = useManager()
  useEffect(() => {
    if (launch !== 'manager' || !manager) return
    useManagerPanel.getState().setOpen(true)
    useLaunch.getState().done()
  }, [launch, manager])

  return (
    <div className={`app${fullscreen ? ' app--full' : ''}${mobile ? ' app--mobile' : ''}`}>
      <Navbar />
      {!mobile && <LeftSidebar />}
      <main className="stage">
        <Office />
        <LabelLayer />
        <RenderSwitch />
        <AppReload />
      </main>
      {mobile ? (
        <MobileDock />
      ) : (
        <>
          <AgentsPanel />
          <FollowUps />
        </>
      )}
      <AgentProfileDrawer />
      <ManagerPanel />
      <AutomationModal />
      <ProfileModal />
      <UrlModals />
      <ConfirmLayer />
      {update.ready && (
        <div className="sync-toast sync-toast--update" role="status">
          <LuRefreshCw />
          <span>A new version of After Office is available.</span>
          <button className="small primary" onClick={update.apply}>
            Reload
          </button>
        </div>
      )}
      {replied && (
        <div className="sync-toast sync-toast--reply" role="status" key={replied.at}>
          <LuMessageSquareText />
          <span>
            <b>{replied.name}</b> replied
          </span>
          <button
            className="small primary"
            onClick={() => {
              const office = useOffice.getState()
              if (office.agents.find((a) => a.id === replied.agentId)?.kind === 'manager') useManagerPanel.getState().setOpen(true)
              else office.openProfile(replied.agentId)
              useReplyAlerts.getState().dismiss()
            }}
          >
            Open chat
          </button>
          <button className="icon-btn small ghost" data-tip="Dismiss" aria-label="Dismiss" onClick={() => useReplyAlerts.getState().dismiss()}>
            <LuX />
          </button>
        </div>
      )}
      {syncError && (
        <div className="sync-toast" role="alert">
          <LuTriangleAlert />
          <span>{syncError}</span>
          <button className="icon-btn small ghost" data-tip="Dismiss" aria-label="Dismiss" onClick={() => useDashboard.setState({ syncError: null })}>
            <LuX />
          </button>
        </div>
      )}
    </div>
  )
}
