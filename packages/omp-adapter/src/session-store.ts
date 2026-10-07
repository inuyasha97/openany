/**
 * OMP session store reader.
 *
 * OMP persists each session as JSONL under `~/.omp/agent/sessions`. The
 * optional first physical record is a fixed-width `title`; the first logical
 * record is the `session` header. Project directory names are implementation
 * details, so files are discovered by walking the root rather than
 * constructed from an id.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OmpSessionInfo } from "./runtime"

export type OmpSessionFs = {
  readdir: (dir: string, options: { recursive: true }) => string[]
  readFile: (file: string, encoding: "utf8") => string
  rm: (file: string, options: { force: true }) => void
  mkdir: (dir: string, options: { recursive: true }) => void
  rename: (from: string, to: string) => void
}

export const defaultSessionsRoot = (): string => path.join(os.homedir(), ".omp", "agent", "sessions")

export const parseSessionFile = (text: string): { id: string; cwd: string; title: string } | null => {
  let header: { id?: unknown; cwd?: unknown; title?: unknown } | null = null
  let title = ""
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: { type?: unknown; id?: unknown; cwd?: unknown; title?: unknown; v?: unknown }
    try {
      record = JSON.parse(trimmed) as typeof record
    } catch {
      continue
    }
    if (record.type === "title" && record.v === 1) {
      if (typeof record.title === "string") title = record.title
      continue
    }
    if (record.type === "session") {
      header = record
      break
    }
  }
  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return null
  const headerTitle = typeof header.title === "string" ? header.title : ""
  return { id: header.id, cwd: header.cwd, title: title || headerTitle }
}

export type OmpSessionStore = {
  list: () => Promise<OmpSessionInfo[]>
  delete: (sessionPath: string) => Promise<void>
  move: (sessionPath: string, toDirectory: string) => Promise<OmpSessionInfo>
}

const defaultFs: OmpSessionFs = {
  readdir: (dir, options) => fs.readdirSync(dir, { ...options, encoding: "utf8" }),
  readFile: (file, encoding) => fs.readFileSync(file, encoding),
  rm: (file, options) => fs.rmSync(file, options),
  mkdir: (dir, options) => {
    fs.mkdirSync(dir, options)
  },
  rename: (from, to) => fs.renameSync(from, to),
}

export const createSessionStore = (options: { root?: string; fs?: OmpSessionFs } = {}): OmpSessionStore => {
  const root = options.root ?? defaultSessionsRoot()
  const io = options.fs ?? defaultFs

  const discover = (): string[] => {
    try {
      return io
        .readdir(root, { recursive: true })
        // OMP enumerates `*/*.jsonl`: one project directory, one session file.
        // A deeper file is a subagent transcript, not a session.
        .filter((entry) => entry.endsWith(".jsonl") && entry.split(/[\\/]/).length === 2)
        .map((entry) => path.join(root, entry))
    } catch {
      return []
    }
  }

  return {
    async list() {
      const sessions: OmpSessionInfo[] = []
      for (const file of discover()) {
        try {
          const parsed = parseSessionFile(io.readFile(file, "utf8"))
          if (parsed) sessions.push({ id: parsed.id, sessionPath: file, cwd: parsed.cwd, title: parsed.title })
        } catch {
          // a single unreadable file must not drop the rest
        }
      }
      return sessions
    },

    async delete(sessionPath) {
      io.rm(sessionPath, { force: true })
    },

    async move(sessionPath, toDirectory) {
      const parsed = parseSessionFile(io.readFile(sessionPath, "utf8"))
      if (!parsed) throw new Error(`not an omp session file: ${sessionPath}`)
      const targetDir = path.join(toDirectory, ".omp-sessions")
      io.mkdir(targetDir, { recursive: true })
      const target = path.join(targetDir, path.basename(sessionPath))
      io.rename(sessionPath, target)
      return { id: parsed.id, sessionPath: target, cwd: toDirectory, title: parsed.title }
    },
  }
}
