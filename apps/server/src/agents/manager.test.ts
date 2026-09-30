import { describe, expect, test } from 'bun:test'
import { inputBoxText, parseDialogOptions } from './manager'

describe('parseDialogOptions', () => {
  test('reads numbered options, including the selected one', () => {
    const screen = [
      '   1. Ensure out/ exists (mkdir -p out).',
      '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '   ❯ 1. Yes, and use auto mode',
      '     2. Yes, auto-accept edits',
      '     3. Yes, manually approve edits',
      '     4. Tell Claude what to change',
      '        shift+tab to approve with this feedback',
    ].join('\n')
    expect(parseDialogOptions(screen)).toEqual([
      { n: '1', label: 'Yes, and use auto mode' },
      { n: '2', label: 'Yes, auto-accept edits' },
      { n: '3', label: 'Yes, manually approve edits' },
      { n: '4', label: 'Tell Claude what to change' },
    ])
  })
})

describe('inputBoxText', () => {
  const rule = '─'.repeat(40)
  test('reads the prompt box between the last two rules', () => {
    expect(inputBoxText(['⏺ done', rule, '❯ Write the numbers', rule, '  footer'].join('\n'))).toBe('Write the numbers')
  })
  test('empty box', () => {
    expect(inputBoxText([rule, '❯ ', rule].join('\n'))).toBe('')
  })
})
