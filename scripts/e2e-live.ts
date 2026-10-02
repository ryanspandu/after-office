// End-to-end test against a running server with a throwaway "QA" agent (real Claude Code, Haiku; spends a few
// thousand tokens). Takes ~6 minutes because cron tests wait for real minutes.
//
//   E2E_USER=admin E2E_PASSWORD=… bun scripts/e2e-live.ts            (server on http://127.0.0.1:8787)
//
// Creates, and deletes at the end: agent "QA" (~/after-office-agents/qa), tasks qa-task-*, crons qa-cron-*.
// It restarts the dev server once (rewrites apps/server/src/index.ts unchanged) to test recovery.
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8787'
const user = process.env.E2E_USER ?? 'admin'
const devPass = process.env.E2E_PASSWORD ?? ''
if (!devPass) throw new Error('Set E2E_PASSWORD')

let cookie = ''
const results: [string, boolean, string][] = []
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
function check(name: string, ok: boolean, info = '') {
  results.push([name, ok, info])
  log(ok ? 'PASS' : 'FAIL', name, info)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api(path: string, init: RequestInit & { raw?: boolean } = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { cookie, ...(init.method && init.method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(init.headers as object) },
  })
  return res
}
const j = async (path: string, method = 'GET', body?: unknown) => {
  const r = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json().catch(() => null)
  return { status: r.status, data }
}

async function snapshot() {
  const ctrl = new AbortController()
  const res = await fetch(BASE + '/api/events', { headers: { cookie }, signal: ctrl.signal })
  const reader = res.body!.getReader()
  let buf = ''
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value)
  ctrl.abort()
  return JSON.parse(buf.split('data: ')[1].split('\n')[0])
}
const agentState = async (id: string) => (await snapshot()).agents.find((a: { id: string }) => a.id === id)
async function waitFor<T>(label: string, fn: () => Promise<T | undefined | false | null>, timeout = 90_000, every = 1500): Promise<T | undefined> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined)
    if (v) return v as T
    await sleep(every)
  }
  log('timeout waiting for', label)
  return undefined
}
const chatText = async (id: string) => JSON.stringify((await j(`/api/agents/${id}/chat?limit=80`)).data)
/** Only what the agent said (prompts contain the markers too). */
const replies = async (id: string) =>
  ((await j(`/api/agents/${id}/chat?limit=120`)).data as { kind: string; text?: string }[]).filter((i) => i.kind === 'assistant').map((i) => i.text).join('\n')
const tmuxHas = async (s: string) => (await Bun.spawn(['tmux', 'has-session', '-t', `=${s}`]).exited) === 0
const screen = async (s: string) => new Response(Bun.spawn(['tmux', 'capture-pane', '-p', '-t', `=${s}:`]).stdout).text()
const idle = (id: string, label: string, timeout = 120_000) =>
  waitFor(label, async () => {
    const a = await agentState(id)
    return a?.status === 'idle' && a
  }, timeout)
const followUp = (id: string, kind: string, timeout = 90_000) =>
  waitFor(`${kind} follow-up`, async () => (await snapshot()).followUps.find((f: { agentId: string; kind: string }) => f.agentId === id && f.kind === kind), timeout, 1000)
async function prompt(id: string, text: string) {
  const r = await j(`/api/agents/${id}/prompt`, 'POST', { text })
  if (r.status !== 200) log('prompt failed', r)
}
function nextMinute(tz: string, plus = 1) {
  const d = new Date(Date.now() + plus * 60_000)
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return { hhmm: `${g('hour')}:${g('minute')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  // ── auth ──
  check('auth: /api requires a session', (await fetch(BASE + '/api/agents')).status === 401)
  const bad = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-nobody', password: 'wrong' }) })
  check('auth: wrong login rejected', bad.status === 401)
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: devPass }) })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  check('auth: login', login.status === 200 && !!cookie)
  check('auth: me', (await j('/api/auth/me')).status === 200)
  check('csrf: write without JSON content-type refused', (await fetch(BASE + '/api/tasks/x', { method: 'DELETE', headers: { cookie } })).status === 415)
  check('hooks: /hook without token refused', (await fetch(BASE + '/hook', { method: 'POST', body: '{}' })).status === 401)
  const sys = await j('/api/system')
  check('system metrics', sys.status === 200 && typeof sys.data.cpu === 'number' && sys.data.memTotalGb > 0)
  check('usage endpoint', (await j('/api/usage?from=2026-01-01')).status === 200)
  const snap0 = await snapshot()
  check('SSE snapshot has agents/work/timezone', Array.isArray(snap0.agents) && !!snap0.work && !!snap0.work.timezone, snap0.work?.timezone)
  const tz: string = snap0.work.timezone

  // ── create agent ──
  const old = (await j('/api/agents')).data.find((a: { name: string }) => a.name === 'QA')
  if (old) await j(`/api/agents/${old.id}`, 'DELETE')
  const created = await j('/api/agents', 'POST', { name: 'QA', cwd: `${homedir()}/after-office-agents/qa`, model: 'haiku', permissionMode: 'default', role: 'QA bot' })
  check('agent: create', created.status === 201, created.data?.error ?? '')
  const A = created.data
  const id: string = A.id
  const sess: string = A.tmuxSession
  check('agent: tmux session exists', await tmuxHas(sess), sess)
  const up = await idle(id, 'agent idle after start', 90_000)
  check('agent: comes online (statusline)', !!up, up ? `${up.modelName} ${up.permissionMode}` : '')

  // ── chat ──
  await prompt(id, 'Reply with exactly: PONG-QA-1')
  const sawWorking = await waitFor('working', async () => (await agentState(id))?.status === 'working', 30_000, 400)
  check('chat: agent goes working', !!sawWorking)
  const r1 = await waitFor('reply', async () => (await agentState(id))?.lastMessage?.includes('PONG-QA-1') && (await agentState(id)).status === 'idle', 90_000)
  check('chat: reply + idle', !!r1)
  check('chat: transcript has prompt and reply', (await chatText(id)).includes('PONG-QA-1'))

  // ── permission allow / deny ──
  await prompt(id, 'Use the Bash tool to run exactly: touch qa-allow.txt   Then reply DONE-ALLOW.')
  let f = await followUp(id, 'permission')
  check('permission: card appears', !!f, f?.tool)
  if (f) {
    const a = await agentState(id)
    check('permission: agent waiting', a.status === 'waiting' && a.waitingFor === 'permission')
    check('permission: allow', (await j(`/api/followups/${encodeURIComponent(f.id)}/decision`, 'POST', { type: 'allow' })).status === 200)
    check('permission: command ran', !!(await waitFor('file', async () => Bun.file(`${homedir()}/after-office-agents/qa/qa-allow.txt`).exists(), 60_000)))
    await idle(id, 'idle after allow')
  }
  await prompt(id, 'Use the Bash tool to run exactly: touch qa-deny.txt   If it is denied, reply DENIED-OK and stop.')
  f = await followUp(id, 'permission')
  if (f) {
    check('permission: deny', (await j(`/api/followups/${encodeURIComponent(f.id)}/decision`, 'POST', { type: 'deny', note: 'QA deny test' })).status === 200)
    await idle(id, 'idle after deny')
    check('permission: denied command did not run', !(await Bun.file(`${homedir()}/after-office-agents/qa/qa-deny.txt`).exists()))
  } else check('permission: deny card', false)

  // ── AskUserQuestion ──
  await prompt(id, 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. Then reply with only my choice in capitals.')
  f = await followUp(id, 'question')
  check('question: card appears', !!f)
  if (f) {
    const q = (f.input.questions as { question: string }[])[0].question
    check('question: answer', (await j(`/api/followups/${encodeURIComponent(f.id)}/decision`, 'POST', { type: 'answer', answers: { [q]: 'Blue' } })).status === 200)
    const got = await waitFor('answer used', async () => {
      const a = await agentState(id)
      return a.status === 'idle' && /BLUE/i.test(a.lastMessage ?? '') && a
    })
    check('question: agent used the answer', !!got, got?.lastMessage)
  }

  // ── modes ──
  let m = await j(`/api/agents/${id}/mode`, 'POST', { mode: 'acceptEdits' })
  check('mode: switch to acceptEdits', m.status === 200 && m.data.mode === 'acceptEdits' && /accept edits on/i.test(await screen(sess)), JSON.stringify(m.data))
  m = await j(`/api/agents/${id}/mode`, 'POST', { mode: 'default' })
  check('mode: back to default', m.status === 200 && !m.data.deferred)
  // deferred while a dialog is open
  await prompt(id, 'Use the Bash tool to run exactly: touch qa-deferred.txt   Then reply DONE-DEFERRED.')
  f = await followUp(id, 'permission')
  if (f) {
    m = await j(`/api/agents/${id}/mode`, 'POST', { mode: 'acceptEdits' })
    check('mode: deferred while dialog open', m.data?.deferred === true)
    await j(`/api/followups/${encodeURIComponent(f.id)}/decision`, 'POST', { type: 'allow' })
    await idle(id, 'idle after deferred')
    const ok = await waitFor('deferred mode applied', async () => /accept edits on/i.test(await screen(sess)), 20_000)
    check('mode: deferred change applied after answering', !!ok)
    await j(`/api/agents/${id}/mode`, 'POST', { mode: 'default' })
  } else check('mode: deferred test card', false)

  // ── plan mode ──
  m = await j(`/api/agents/${id}/mode`, 'POST', { mode: 'plan' })
  check('mode: plan', m.data?.mode === 'plan')
  await prompt(id, 'Make a one-step plan to create the file qa-plan.txt containing "hi". Present the plan for approval right away, do not ask questions.')
  f = await followUp(id, 'plan', 120_000)
  check('plan: card appears', !!f)
  if (f) {
    const withOpts = await waitFor('plan options', async () => (await snapshot()).followUps.find((x: { id: string }) => x.id === f.id)?.input?.options, 20_000, 700)
    check('plan: dialog options read from screen', Array.isArray(withOpts) && withOpts.length > 1, JSON.stringify(withOpts))
    const opt = (withOpts as string[] | undefined)?.find((o) => /manually approve/i.test(o)) ?? (withOpts as string[] | undefined)?.find((o) => /^yes/i.test(o))
    if (opt) {
      check('plan: approve', (await j(`/api/followups/${encodeURIComponent(f.id)}/decision`, 'POST', { type: 'plan', option: opt })).status === 200, opt)
      // manual approval: the Write asks for permission
      const w = await followUp(id, 'permission', 60_000)
      if (w) await j(`/api/followups/${encodeURIComponent(w.id)}/decision`, 'POST', { type: 'allow' })
      check('plan: executed', !!(await waitFor('plan file', async () => Bun.file(`${homedir()}/after-office-agents/qa/qa-plan.txt`).exists(), 60_000)))
      await idle(id, 'idle after plan')
    }
  }
  await j(`/api/agents/${id}/mode`, 'POST', { mode: 'default' })

  // ── interrupt ──
  await idle(id, 'idle before interrupt')
  await prompt(id, 'Write the numbers from 1 to 2000, one per line, no tools.')
  check('prompt: submitted (input box empty)', !!(await waitFor('submitted', async () => !/Write the numbers/.test((await screen(sess)).split('─'.repeat(20)).slice(-2)[0] ?? ''), 10_000, 500)))
  await waitFor('working', async () => (await agentState(id))?.status === 'working', 30_000, 400)
  await sleep(1500)
  check('interrupt: request ok', (await j(`/api/agents/${id}/interrupt`, 'POST', {})).status === 200)
  check('interrupt: agent stops', !!(await idle(id, 'idle after interrupt', 30_000)))
  check('interrupt: screen shows the turn was interrupted', /interrupted/i.test(await screen(sess)))

  // ── profile ──
  const prof = await j(`/api/agents/${id}/profile`)
  check('profile: read', prof.status === 200 && typeof prof.data.claudeMd === 'string')
  const put = await j(`/api/agents/${id}/profile`, 'PUT', { ...prof.data, role: 'QA tester', claudeMd: '# QA\nAlways be brief.\n' })
  check('profile: write', put.status === 200, put.data?.error ?? '')
  check('profile: CLAUDE.md on disk', (await Bun.file(`${homedir()}/after-office-agents/qa/CLAUDE.md`).text()).includes('Always be brief'))

  // ── web terminal ──
  const ws = new WebSocket(`ws://127.0.0.1:8787/api/agents/${id}/term`, { headers: { cookie, origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' } } as unknown as string[])
  const bytes = await new Promise<number>((resolve) => {
    let n = 0
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 30 }))
    ws.onmessage = (e) => (n += (e.data as ArrayBuffer).byteLength ?? String(e.data).length)
    ws.onerror = () => resolve(-1)
    setTimeout(() => resolve(n), 2500)
  })
  ws.close()
  check('terminal: websocket streams the TUI', bytes > 100, `${bytes} bytes`)
  const evil = await fetch(BASE + `/api/agents/${id}/term`, { headers: { cookie, origin: 'http://evil.example', upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
  check('terminal: cross-origin refused', evil.status === 403)
  await sleep(1500)

  // ── tasks ──
  const mk = (tid: string, extra: object) =>
    j(`/api/tasks/${tid}`, 'PUT', { title: tid, agentId: id, deadline: Date.now() + 3600e3, priority: 'low', status: 'todo', ...extra })
  await idle(id, 'idle before tasks')
  await mk('qa-task-manual', { description: 'Reply with exactly: TASK-MANUAL-OK' })
  const st = await j('/api/tasks/qa-task-manual/start', 'POST', {})
  check('task: manual start sent', st.data?.result === 'sent', JSON.stringify(st.data))
  const task = (tid: string) => snapshot().then((s) => s.work.tasks.find((t: { id: string }) => t.id === tid))
  check('task: in_progress', (await task('qa-task-manual'))?.status === 'in_progress')
  check('task: review after the agent stops', !!(await waitFor('review', async () => (await task('qa-task-manual'))?.status === 'review', 90_000)))

  // queue: busy agent
  await prompt(id, 'Write the numbers from 1 to 150, one per line, no tools.')
  await waitFor('working', async () => (await agentState(id))?.status === 'working', 30_000, 300)
  await mk('qa-task-queued', { description: 'Reply with exactly: TASK-QUEUED-OK', mode: 'acceptEdits' })
  const q = await j('/api/tasks/qa-task-queued/start', 'POST', {})
  check('task: queued while busy', q.data?.result === 'queued', JSON.stringify(q.data))
  check('task: queued count published', ((await snapshot()).work.queued[id] ?? 0) >= 1)
  const drained = await waitFor('queued delivered', async () => (await replies(id)).includes('TASK-QUEUED-OK') && (await task('qa-task-queued'))?.status === 'review', 150_000)
  check('task: queue drained after Stop, then review', !!drained)
  check('task: per-task mode restored afterwards', !!(await waitFor('mode restored', async () => (await agentState(id))?.permissionMode === 'default' && !/accept edits on/i.test(await screen(sess)), 30_000)))

  // auto start: as soon as free, and scheduled
  await idle(id, 'idle before auto')
  await mk('qa-task-auto', { description: 'Reply with exactly: TASK-AUTO-OK', autoStart: true })
  check('task: auto start (free)', !!(await waitFor('auto', async () => (await replies(id)).includes('TASK-AUTO-OK'), 90_000)))
  await idle(id, 'idle after auto')
  await mk('qa-task-sched', { description: 'Reply with exactly: TASK-SCHED-OK', autoStart: true, startAt: Date.now() + 25_000 })
  await sleep(10_000)
  check('task: scheduled not started early', !(await replies(id)).includes('TASK-SCHED-OK'))
  check('task: scheduled start fires', !!(await waitFor('sched', async () => (await replies(id)).includes('TASK-SCHED-OK'), 90_000)))
  const sched = await task('qa-task-sched')
  // editing an unrelated field must not re-arm it
  await j('/api/tasks/qa-task-sched', 'PUT', { ...sched, priority: 'high' })
  check('task: fires once (edit keeps autoStartedAt)', !!(await task('qa-task-sched'))?.autoStartedAt)
  await idle(id, 'idle after sched')

  // ── cron ──
  const cron = (cid: string, extra: object) => j(`/api/crons/${cid}`, 'PUT', { name: cid, prompt: 'x', times: ['00:00'], days: [0, 1, 2, 3, 4, 5, 6], agentId: id, enabled: true, ...extra })
  const bad1 = await cron('qa-cron-bad', { times: ['25:00'] })
  check('cron: invalid time rejected', bad1.status === 400)
  const n1 = nextMinute(tz, 1)
  await cron('qa-cron-fire', { prompt: 'Reply with exactly: CRON-FIRE-OK', times: [n1.hhmm], fresh: false })
  await cron('qa-cron-off', { prompt: 'Reply with exactly: CRON-OFF-SHOULD-NOT', times: [n1.hhmm], enabled: false })
  await cron('qa-cron-day', { prompt: 'Reply with exactly: CRON-DAY-SHOULD-NOT', times: [n1.hhmm], days: [(n1.weekday + 1) % 7] })
  log('cron scheduled for', n1.hhmm, tz)
  const fired = await waitFor('cron fire', async () => (await replies(id)).includes('CRON-FIRE-OK'), 150_000, 3000)
  check('cron: fires at its time', !!fired)
  await idle(id, 'idle after cron')
  await sleep(25_000) // another scheduler tick in the same minute window
  const crons = (await snapshot()).work.crons
  const fc = crons.find((c: { id: string }) => c.id === 'qa-cron-fire')
  check('cron: recorded once in lastRuns', fc?.lastRuns?.length === 1, JSON.stringify(fc?.lastRuns))
  const text = await chatText(id)
  check('cron: disabled job did not fire', !text.includes('CRON-OFF-SHOULD-NOT'))
  check('cron: job for another weekday did not fire', !text.includes('CRON-DAY-SHOULD-NOT'))
  check('cron: fired exactly once', ((await replies(id)).match(/CRON-FIRE-OK/g) ?? []).length === 1)

  // fresh context: /clear first → new session id
  const before = (await j('/api/agents')).data.find((a: { id: string }) => a.id === id)
  const runRes = await (async () => {
    await cron('qa-cron-fresh', { prompt: 'Reply with exactly: CRON-FRESH-OK', times: ['00:00'], fresh: true })
    return j('/api/crons/qa-cron-fresh/run', 'POST', {})
  })()
  check('cron: run now', runRes.data?.result === 'sent', JSON.stringify(runRes.data))
  const freshOk = await waitFor('fresh', async () => (await replies(id)).includes('CRON-FRESH-OK'), 90_000)
  check('cron: fresh context reply', !!freshOk)
  const after = (await j('/api/agents')).data.find((a: { id: string }) => a.id === id)
  check('cron: fresh context started a new conversation', after.sessionId && after.sessionId !== before.sessionId, `${before.sessionId?.slice(0, 8)} → ${after.sessionId?.slice(0, 8)}`)
  check('cron: agent stayed online through /clear', after.status !== 'offline')
  const chatAfterClear = await chatText(id)
  check('chat: follows the new conversation after /clear', !chatAfterClear.includes('PONG-QA-1') && !chatAfterClear.includes('CRON-FIRE-OK'))
  await idle(id, 'idle after fresh')

  // run now while busy → queued
  await prompt(id, 'Write the numbers from 1 to 150, one per line, no tools.')
  await waitFor('working', async () => (await agentState(id))?.status === 'working', 30_000, 300)
  await cron('qa-cron-busy', { prompt: 'Reply with exactly: CRON-BUSY-OK', times: ['00:00'] })
  const busyRun = await j('/api/crons/qa-cron-busy/run', 'POST', {})
  check('cron: run now while busy is queued', busyRun.data?.result === 'queued', JSON.stringify(busyRun.data))
  check('cron: queued prompt delivered later', !!(await waitFor('busy cron', async () => (await replies(id)).includes('CRON-BUSY-OK'), 150_000)))
  await idle(id, 'idle after busy cron')

  // timezone: a cron in another zone fires by that zone's clock
  await j('/api/settings', 'PUT', { timezone: 'America/New_York' })
  const n2 = nextMinute('America/New_York', 1)
  await cron('qa-cron-tz', { prompt: 'Reply with exactly: CRON-TZ-OK', times: [n2.hhmm] })
  check('settings: timezone saved', (await snapshot()).work.timezone === 'America/New_York')
  check('cron: fires in the office timezone', !!(await waitFor('tz cron', async () => (await replies(id)).includes('CRON-TZ-OK'), 150_000, 3000)))
  await j('/api/settings', 'PUT', { timezone: tz })
  check('settings: timezone restored', (await snapshot()).work.timezone === tz)
  await idle(id, 'idle after tz cron')

  // ── model switch (restart with --resume) ──
  const ms = await j(`/api/agents/${id}/model`, 'POST', { model: 'sonnet' })
  check('model: switch restarts the session', ms.status === 200, ms.data?.error ?? '')
  const son = await waitFor('model sonnet', async () => {
    const a = await agentState(id)
    return a?.status !== 'offline' && /sonnet/i.test(a?.model ?? '') && a
  }, 90_000)
  check('model: statusline reports the new model', !!son, son?.modelName)
  await j(`/api/agents/${id}/model`, 'POST', { model: 'haiku' })
  await waitFor('model haiku', async () => /haiku/i.test((await agentState(id))?.model ?? ''), 90_000)

  // ── restart + auto-revive ──
  check('restart: ok', (await j(`/api/agents/${id}/restart`, 'POST', {})).status === 200)
  await idle(id, 'idle after restart', 60_000)
  await Bun.spawn(['tmux', 'kill-session', '-t', `=${sess}`]).exited
  const off = await waitFor('offline', async () => (await agentState(id))?.status === 'offline', 20_000, 1000)
  check('reconciler: dead session detected', !!off)
  check('reconciler: session revived', !!(await waitFor('revived', async () => (await tmuxHas(sess)) && (await agentState(id))?.status === 'idle', 90_000)))

  // ── orphaned dialog after a server restart ──
  await prompt(id, 'Use the Bash tool to run exactly: touch qa-orphan.txt   Then reply DONE-ORPHAN.')
  f = await followUp(id, 'permission')
  if (f) {
    // restart the server (bun --watch) while the hook request is held
    const idx = resolve(import.meta.dir, '../apps/server/src/index.ts')
    await Bun.write(idx, await Bun.file(idx).text())
    await sleep(3000)
    await waitFor('server back', async () => (await fetch(BASE + '/health')).ok, 30_000, 500)
    const adopted = await waitFor('adopted', async () => (await snapshot()).followUps.find((x: { agentId: string }) => x.agentId === id), 30_000, 1000)
    check('restart: dialog still offered on the dashboard', !!adopted, adopted?.id)
    if (adopted) {
      check('restart: answering it works (keys)', (await j(`/api/followups/${encodeURIComponent(adopted.id)}/decision`, 'POST', { type: 'allow' })).status === 200)
      check('restart: command ran', !!(await waitFor('orphan file', async () => Bun.file(`${homedir()}/after-office-agents/qa/qa-orphan.txt`).exists(), 60_000)))
    }
    await idle(id, 'idle after orphan')
  } else check('restart: permission card', false)

  // ── usage ──
  const usage = await j('/api/usage?from=2026-01-01')
  check('usage: tokens counted for QA', usage.data.some((u: { agent_id: string; output: number }) => u.agent_id === id && u.output > 0))

  // ── cleanup ──
  for (const t of ['qa-task-manual', 'qa-task-queued', 'qa-task-auto', 'qa-task-sched']) await j(`/api/tasks/${t}`, 'DELETE')
  for (const c of ['qa-cron-fire', 'qa-cron-off', 'qa-cron-day', 'qa-cron-fresh', 'qa-cron-busy', 'qa-cron-tz']) await j(`/api/crons/${c}`, 'DELETE')
  const del = await j(`/api/agents/${id}`, 'DELETE')
  check('agent: delete', del.status === 200)
  check('agent: tmux session gone', !(await waitFor('gone', async () => !(await tmuxHas(sess)), 15_000)) === false)
  check('agent: removed from the list', !(await j('/api/agents')).data.some((a: { id: string }) => a.id === id))
}

main()
  .catch((e) => check('script crashed', false, String(e?.stack ?? e)))
  .finally(() => {
    const failed = results.filter((r) => !r[1])
    console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`)
    for (const [n, , i] of failed) console.log('FAILED:', n, i)
    process.exit(0)
  })
