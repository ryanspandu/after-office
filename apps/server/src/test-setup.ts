import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

// Loaded before every test file (bunfig.toml): tests always get a throwaway database and their own tmux server,
// even with a plain `bun test`, so they never touch the real office or spawn sessions next to the real agents.
process.env.OFFICE_DATA_DIR = mkdtempSync(join(tmpdir(), 'after-office-test-'))
// agents' and projects' folders go to a throwaway folder too (never ~/after-office); it has to be an allowed root
const scratch = mkdtempSync(join(tmpdir(), 'after-office-test-home-'))
process.env.OFFICE_AGENTS_DIR = join(scratch, 'after-office')
process.env.OFFICE_ROOT = [scratch, dirname(resolve(import.meta.dir, '../../..')), homedir()].join(':')
// …and a Claude config folder of its own (transcripts the tests write), never the real ~/.claude
process.env.OFFICE_CLAUDE_CONFIG_DIR = join(scratch, 'claude-config')
process.env.OFFICE_TMUX_NAME = `after-office-test-${process.pid}`
delete process.env.OFFICE_TMUX_SOCKET
