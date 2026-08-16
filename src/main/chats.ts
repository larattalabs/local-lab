import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chat } from '@shared/types'
import { RUNS_DIR } from './env'

/**
 * Chats live beside the runs they reference, one JSON file each. The dialogue
 * is the only thing stored here — artifacts stay in their run directories, so
 * deleting a chat never deletes a generation (it just goes back to being an
 * unfiled run).
 */
const CHATS_DIR = join(RUNS_DIR, 'chats')

function chatPath(id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`bad chat id: ${id}`)
  return join(CHATS_DIR, `${id}.json`)
}

export function listChats(): Chat[] {
  if (!existsSync(CHATS_DIR)) return []
  const out: Chat[] = []
  for (const name of readdirSync(CHATS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const chat = JSON.parse(readFileSync(join(CHATS_DIR, name), 'utf8')) as Chat
      // A gen still marked running/queued here means the app died mid-run;
      // nothing will ever finish it, so don't render an eternal spinner.
      for (const m of chat.messages) {
        if (m.state === 'running' || m.state === 'queued') m.state = 'cancelled'
      }
      out.push(chat)
    } catch {
      // One corrupt chat file must not take down the whole sidebar.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveChat(chat: Chat): void {
  mkdirSync(CHATS_DIR, { recursive: true })
  writeFileSync(chatPath(chat.id), JSON.stringify(chat, null, 2))
}

export function deleteChat(id: string): void {
  rmSync(chatPath(id), { force: true })
}
