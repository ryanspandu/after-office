import { describe, expect, test } from 'bun:test'
import { applyHook, applyStatusline, applyTick, initialRuntime, STALE_WORKING_MS, type HookPayload, type Runtime } from './state'

const run = (events: HookPayload[], start: Runtime = { ...initialRuntime(), status: 'idle' }) =>
  events.reduce((rt, e, i) => applyHook(rt, e, 1000 + i), start)

describe('agent state machine', () => {
  test('prompt → tool → stop goes working → idle and keeps the last message', () => {
    const rt = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the  flaky\ntest', permission_mode: 'default' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
      { hook_event_name: 'Stop', last_assistant_message: 'Done.' },
    ])
    expect(rt.status).toBe('idle')
    expect(rt.task).toBe('Fix the flaky test')
    expect(rt.lastMessage).toBe('Done.')
    expect(rt.permissionMode).toBe('default')
  })

  test('permission request waits, the next tool use resumes work', () => {
    const waiting = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    ])
    expect(waiting.status).toBe('waiting')
    expect(waiting.waitingFor).toBe('permission')
    expect(applyHook(waiting, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }).status).toBe('working')
  })

  test('plan and question requests are labelled and survive their own PreToolUse', () => {
    const plan = run([{ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', permission_mode: 'plan' }])
    expect(plan.waitingFor).toBe('plan')
    const q = run([
      { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' },
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
    ])
    expect(q.status).toBe('waiting')
    expect(q.waitingFor).toBe('question')
  })

  test('mode changes are picked up from any hook', () => {
    const rt = run([
      { hook_event_name: 'PreToolUse', tool_name: 'Write', permission_mode: 'plan' },
      { hook_event_name: 'PostToolUse', tool_name: 'Write', permission_mode: 'acceptEdits' },
    ])
    expect(rt.permissionMode).toBe('acceptEdits')
  })

  test('unknown modes are ignored', () => {
    const rt = run([{ hook_event_name: 'PreToolUse', tool_name: 'Read', permission_mode: 'something-new' }], {
      ...initialRuntime(),
      status: 'idle',
      permissionMode: 'plan',
    })
    expect(rt.permissionMode).toBe('plan')
  })

  test('subagent noise does not change status', () => {
    const rt = run([{ hook_event_name: 'Stop' }, { hook_event_name: 'SubagentStop' }])
    expect(rt.status).toBe('idle')
  })

  test('first statusline brings an offline agent online with model + context', () => {
    const rt = applyStatusline(initialRuntime(), {
      session_id: 's1',
      model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
      context_window: { used_percentage: 18 },
      cost: { total_cost_usd: 0.07 },
    })
    expect(rt.status).toBe('idle')
    expect(rt.model).toBe('claude-sonnet-5')
    expect(rt.contextPct).toBe(18)
    expect(rt.costUsd).toBe(0.07)
  })

  test('a stale working agent becomes idle', () => {
    const rt: Runtime = { ...initialRuntime(), status: 'working', lastEventAt: 0 }
    expect(applyTick(rt, STALE_WORKING_MS - 1).status).toBe('working')
    expect(applyTick(rt, STALE_WORKING_MS + 1).status).toBe('idle')
  })

  test('SessionEnd goes offline', () => {
    expect(run([{ hook_event_name: 'SessionEnd' }]).status).toBe('offline')
  })

  test('each finished turn is one unread reply', () => {
    const rt = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'Stop', last_assistant_message: 'a' }, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'Stop', last_assistant_message: 'b' }])
    expect(rt.unread).toBe(2)
    expect(rt.lastMessage).toBe('b')
  })

  test('/clear ends the conversation but the agent stays at its desk', () => {
    expect(run([{ hook_event_name: 'SessionEnd', reason: 'clear' }]).status).toBe('idle')
  })
})
