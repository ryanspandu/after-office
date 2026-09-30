// Two-factor off, for a lost phone with no recovery code left:
//
//   bun run auth:reset-2fa
//
// Signs every browser out; the next sign-in (password) sets two-factor up again with a new QR code. Only someone with
// shell access to the server can run this (on the VPS: as the dashboard's user, with its env file).
import { sessionsRepo, settingsRepo } from './db'

if (!settingsRepo.get('twoFactor')) {
  console.log('Two-factor is not set up: nothing to reset.')
  process.exit(0)
}
const answer = (prompt('Turn two-factor off and sign every browser out? [y/N]') ?? '').trim().toLowerCase()
if (answer !== 'y' && answer !== 'yes') {
  console.log('Nothing changed.')
  process.exit(0)
}
settingsRepo.delete('twoFactor')
settingsRepo.delete('bossMode')
sessionsRepo.clear()
console.log('Done. Sign in with your password: the dashboard asks you to set up two-factor again (scan a new QR code).')
