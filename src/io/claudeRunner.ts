import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function copySessionTemplate(src: string, dest: string) {
  return cp(src, dest, { recursive: true })
}

export async function createSessionFolder(sessionId: string, templateDir: string, sessionDir: string) {
  await copySessionTemplate(templateDir, sessionDir)
  await mkdir(path.join(sessionDir, 'input'), { recursive: true })
  await mkdir(path.join(sessionDir, 'output'), { recursive: true })
  await writeFile(
    path.join(sessionDir, 'metadata.json'),
    JSON.stringify({
      session_id: sessionId,
      // not known until the SDK's first response — 2.2 overwrites this once query() starts
      claude_session_id: '',
      created_at: new Date().toISOString(),
    }),
  )
  await writeFile(path.join(sessionDir, 'usage.json'), JSON.stringify([]))
}