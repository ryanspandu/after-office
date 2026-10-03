import { Hono } from 'hono'
import { basename } from 'node:path'
import { AgentError } from '../agents/errors'
import { requireFreshCode } from '../auth'
import { addChunk, exportPath, migrateStatus, startExport, startImport, startUpload } from '../work/migrate'

// Move this office (Office settings): export everything to one file, import such a file (work/migrate.ts). Both start
// with a fresh two-factor code; the file's secrets are locked with the owner's passphrase.

export const migrateRoutes = new Hono()
migrateRoutes.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ error: err.message }, err.status)
  console.error('[migrate]', err)
  return c.json({ error: err instanceof Error ? err.message : 'Something went wrong' }, 500)
})

migrateRoutes.get('/migrate/status', (c) => c.json({ job: migrateStatus() }))

migrateRoutes.post('/migrate/export', async (c) => {
  const body = await c.req.json<{ code?: unknown; passphrase?: unknown; folders?: unknown; conversations?: unknown }>().catch(() => null)
  const refused = requireFreshCode(c, body?.code)
  if (refused) return refused
  return c.json({ job: startExport({ passphrase: body?.passphrase, folders: body?.folders === true, conversations: body?.conversations === true }) })
})

migrateRoutes.get('/migrate/download', (c) => {
  const file = exportPath()
  if (!file) return c.json({ error: 'No export file: export again' }, 404)
  const f = Bun.file(file)
  return new Response(f, {
    headers: {
      'content-type': 'application/x-tar',
      'content-length': String(f.size),
      'content-disposition': `attachment; filename="${basename(file)}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
})

// import: the code first, then the file in pieces (requests are limited in size), then the import itself
migrateRoutes.post('/migrate/upload', async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null)
  const refused = requireFreshCode(c, body?.code)
  if (refused) return refused
  return c.json(startUpload())
})

migrateRoutes.post('/migrate/upload/:id', async (c) => {
  const offset = Number(c.req.header('x-offset'))
  if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: 'Missing X-Offset' }, 400)
  return c.json(addChunk(c.req.param('id'), offset, new Uint8Array(await c.req.arrayBuffer())))
})

migrateRoutes.post('/migrate/import', async (c) => {
  const body = await c.req.json<{ id?: unknown; passphrase?: unknown }>().catch(() => null)
  return c.json({ job: await startImport({ id: body?.id, passphrase: body?.passphrase }) })
})
