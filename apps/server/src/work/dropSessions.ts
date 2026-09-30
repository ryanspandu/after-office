import { db } from '../db'
import { publishWork } from './work'

/**
 * Once: a project page briefly had "sessions" (tasks shown as chats, flagged `session`, their turns kept out of Reports
 * as `hidden` reports). The page is gone; the owner chose to delete what it left: those tasks with their comments,
 * queued prompts and reports, and every hidden report.
 */
export function dropProjectSessions() {
  const ids = db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE json_extract(data, '$.session') = 1`)
    .all()
    .map((r) => r.id)
  const hidden = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM reports WHERE json_extract(data, '$.hidden') = 1`).get()?.n ?? 0
  if (!ids.length && !hidden) return
  db.transaction(() => {
    for (const id of ids) {
      db.query('DELETE FROM task_comments WHERE task_id = ?').run(id)
      db.query('DELETE FROM prompt_queue WHERE task_id = ?').run(id)
      db.query(`DELETE FROM reports WHERE json_extract(data, '$.refId') = ?`).run(id)
      db.query('DELETE FROM tasks WHERE id = ?').run(id)
    }
    db.query(`DELETE FROM reports WHERE json_extract(data, '$.hidden') = 1`).run()
  })()
  console.log(`[work] removed ${ids.length} project-page session task(s) and ${hidden} hidden report(s)`)
  publishWork('tasks')
  publishWork('reports')
}
