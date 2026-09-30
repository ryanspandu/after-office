// `bun run icons`: runs scripts/make-icons.py with a Python that has Pillow. The first `python3` on PATH may not
// (e.g. macOS's own /usr/bin/python3), so a few usual ones are tried; $PYTHON wins if set.
import { join } from 'node:path'

const candidates = [
  process.env.PYTHON,
  'python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  ...['3.14', '3.13', '3.12', '3.11', '3.10', '3.9'].flatMap((v) => [`python${v}`, `/opt/homebrew/bin/python${v}`, `/usr/local/bin/python${v}`]),
  'python',
].filter((p): p is string => !!p)

const hasPillow = (py: string) => {
  try {
    return Bun.spawnSync([py, '-c', 'import PIL'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  } catch {
    return false // not installed
  }
}

const python = candidates.find(hasPillow)
if (!python) {
  console.error('No Python with Pillow found. Install it, e.g.:\n  brew install pillow\n  or: python3 -m pip install --user Pillow\nor point to one: PYTHON=/path/to/python3 bun run icons')
  process.exit(1)
}
console.log(`using ${python}`)
const run = Bun.spawnSync([python, join(import.meta.dir, 'make-icons.py')], { stdout: 'inherit', stderr: 'inherit' })
process.exit(run.exitCode ?? 1)
