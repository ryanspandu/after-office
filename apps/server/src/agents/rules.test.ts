import { expect, test } from 'bun:test'
import { defaultRulePacks, looksLikeCoding } from '@after-office/shared'
import { applyRules, cleanPacks, renderRules, rulesIn } from './rules'

// Office rules in CLAUDE.md: marked blocks the dashboard adds, updates and removes; the owner's own text is kept.

test('default rules by role', () => {
  for (const r of ['Full-stack engineer', 'Frontend dev', 'Software Engineer', 'QA', 'Backend developer']) expect(looksLikeCoding(r)).toBe(true)
  for (const r of ['Secretary', 'Marketing', 'Research', 'General Manager', '']) expect(looksLikeCoding(r)).toBe(false)
  expect(defaultRulePacks('Secretary')).toEqual(['office'])
  expect(defaultRulePacks('Full-stack engineer')).toEqual(['office', 'engineering'])
  expect(defaultRulePacks('Marketing')).toEqual(['office'])
  expect(defaultRulePacks('Secretary')).toEqual(['office'])
  // office is always there; unknown ids go
  expect(cleanPacks(['engineering', 'nope'])).toEqual(['office', 'engineering'])
})

test('apply and remove rule sets without touching the rest', () => {
  const mine = '# Sari\n\nYou do keyword research for the SEO team.\n\n## Style\n- Short bullet points.\n'
  const both = applyRules(mine, ['office', 'engineering'])
  expect(rulesIn(both)).toEqual(['office', 'engineering'])
  expect(both.startsWith(mine.trimEnd())).toBe(true)
  // applying again changes nothing
  expect(applyRules(both, ['office', 'engineering'])).toBe(both)
  // engineering off: only its block goes
  const office = applyRules(both, ['office'])
  expect(rulesIn(office)).toEqual(['office'])
  expect(office).toContain('## Style\n- Short bullet points.')
  expect(office).not.toContain('## Software engineering')
  // a new agent's file
  expect(rulesIn(renderRules(['engineering']))).toEqual(['office', 'engineering'])
})

test('a block of a set no longer offered is removed on the next apply', () => {
  const md = '# A\n\n<!-- after-office:rules:office -->\nx\n<!-- /after-office:rules:office -->\n\n<!-- after-office:rules:marketing -->\n## Digital marketing\n- old\n<!-- /after-office:rules:marketing -->\n'
  const next = applyRules(md, ['office'])
  expect(next).not.toContain('Digital marketing')
  expect(rulesIn(next)).toEqual(['office'])
})

test('an older CLAUDE.md (rules without markers) gets them once, in blocks', () => {
  const old = '# Cella — Secretary\n\nYou keep the office log.\n\n## Working in After Office\n- Old rule one.\n- Old rule two.\n'
  const next = applyRules(old, ['office'])
  expect(next.match(/## Working in After Office/g)?.length).toBe(1)
  expect(next).not.toContain('Old rule one')
  expect(next).toContain('You keep the office log.')
  expect(rulesIn(next)).toEqual(['office'])
  // a section after the old rules stays
  const withMore = '# X\n\n## Working in After Office\n- old\n\n## My notes\n- keep me\n'
  expect(applyRules(withMore, ['office'])).toContain('## My notes\n- keep me')
})
