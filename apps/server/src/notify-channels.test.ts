import { expect, test } from 'bun:test'
import { settingsRepo } from './db'
import { channelNames, channelStatus, removeChannel, saveChannel } from './notify'

// Notification channels set up in the dashboard: checked, stored encrypted, shown only as a hint; the .env wins.
test('channels from the dashboard', () => {
  process.env.SESSION_SECRET ??= 'x'.repeat(40)
  for (const k of ['OFFICE_NTFY_URL', 'OFFICE_TELEGRAM_BOT_TOKEN', 'OFFICE_TELEGRAM_CHAT_ID', 'OFFICE_WEBHOOK_URL']) delete process.env[k]
  expect(() => saveChannel('ntfy', { url: 'http://ntfy.sh/topic' })).toThrow('https://')
  expect(() => saveChannel('ntfy', { url: 'https://ntfy.sh/' })).toThrow('topic')
  expect(() => saveChannel('telegram', { token: 'nope', chatId: '123456' })).toThrow('BotFather')
  saveChannel('ntfy', { url: 'https://ntfy.sh/very-secret-topic-123', token: 'tk_supersecret' })
  saveChannel('telegram', { token: '123456789:AAHfakefakefakefakefakefakefakefake', chatId: '987654321' })
  // stored encrypted: no secret in the database
  const raw = settingsRepo.get('notifyChannels') ?? ''
  for (const secret of ['very-secret-topic', 'tk_supersecret', 'AAHfakefake']) expect(raw).not.toContain(secret)
  // what the dashboard sees: hints only
  const s = channelStatus()
  expect(s.ntfy).toEqual({ source: 'dashboard', preview: 'ntfy.sh/••••-123 · token saved' })
  expect(JSON.stringify(s)).not.toContain('supersecret')
  expect(s.telegram.preview).toBe('bot ••••fake → chat 987654321')
  expect(channelNames()).toEqual(['ntfy', 'telegram'])
  // a new Telegram chat keeps the saved token when it's left empty
  saveChannel('telegram', { token: '', keepToken: true, chatId: '-1001234567' })
  expect(channelStatus().telegram.preview).toBe('bot ••••fake → chat -1001234567')
  // the .env wins
  process.env.OFFICE_NTFY_URL = 'https://ntfy.sh/from-env'
  expect(channelStatus().ntfy).toEqual({ source: 'env' })
  delete process.env.OFFICE_NTFY_URL
  removeChannel('ntfy')
  removeChannel('telegram')
  expect(channelNames()).toEqual([])
})
