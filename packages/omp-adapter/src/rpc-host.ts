/**
 * The real OMP host: `omp --mode rpc` behind `OmpRuntime`.
 *
 * One RPC process per open session. `openSession` spawns, waits for `ready`,
 * optionally switches onto an on-disk session, then reads `get_state` for the
 * live id and session file. Events are forwarded verbatim; the caller owns
 * the projector.
 *
 * Process-scoped commands that OMP only answers for the current session
 * (`get_available_models`, `get_available_commands`, and a rename of a session
 * that is not open) run on a short-lived process that is disposed right after,
 * so the long-lived per-session process count stays bounded.
 */

import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { OmpRpcClient, OmpRpcError, type OmpRpcChild, type OmpRpcSpawn } from "./rpc-client"
import { createSessionStore, type OmpSessionStore } from "./session-store"
import type { OmpMessage } from "./model"
import type { OmpEvent, OmpHost, OmpLoginProvider, OmpLoginResult, OmpSessionHandle } from "./runtime"

export type OmpHostOptions = {
  command?: string
  args?: string[]
  env?: Record<string, string | undefined>
  spawn?: OmpRpcSpawn
  store?: OmpSessionStore
}

/**
 * OMP's own client gives `login` a 600s budget; the same cap here keeps a
 * provider that never answers the browser callback from leaking a process.
 */
const LOGIN_TIMEOUT_MS = 600_000

const defaultSpawn: OmpRpcSpawn = (command, args, options) => {
  const child = nodeSpawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] })
  // SAFETY: `ChildProcess` structurally provides every `OmpRpcChild` member
  // (stdout/stderr streams, stdin write/end, `on`, `kill`); the narrower seam
  // only drops the members the client does not use.
  return child as unknown as OmpRpcChild
}

export type ResolveOmpCommandOptions = {
  env?: Record<string, string | undefined>
  resourcesPath?: string | null
  exists?: (file: string) => boolean
}

/** Electron adds `resourcesPath` to `process` at runtime; Node's types do not declare it. */
const runtimeProcess = process as NodeJS.Process & { resourcesPath?: string }

/**
 * Where the `omp` binary lives, most specific first: an explicit env path, then
 * the binary bundled into the desktop app under `resourcesPath/omp-cli`, then
 * the `PATH` lookup name. Mirrors the OpenCode CLI resolution the desktop used.
 */
export const resolveOmpCommand = (options: ResolveOmpCommandOptions = {}): string => {
  const env = options.env ?? process.env
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
  const explicit = [env.OPENCHAMBER_OMP_PATH, env.OPENCHAMBER_OMP_BIN, env.OMP_BINARY]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  for (const candidate of explicit) if (exists(candidate)) return candidate
  const resourcesPath = options.resourcesPath === undefined ? runtimeProcess.resourcesPath ?? null : options.resourcesPath
  const binaryName = process.platform === "win32" ? "omp.exe" : "omp"
  const roots = [env.OPENCHAMBER_BUNDLED_OMP_CLI_DIR, resourcesPath ? path.join(resourcesPath, "omp-cli") : null]
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, binaryName)
    if (exists(candidate)) return candidate
  }
  return explicit[0] ?? "omp"
}

export const createOmpHost = (options: OmpHostOptions = {}): OmpHost => {
  const command = options.command ?? resolveOmpCommand({ env: options.env })
  const args = options.args ?? ["--mode", "rpc"]
  const spawn = options.spawn ?? defaultSpawn
  const store = options.store ?? createSessionStore()
  const clients = new Map<string, OmpRpcClient>()
  // OMP creates a session's file lazily, so a just-created session is not in the
  // store yet. The live process reports its `sessionFile`; keep it so delete can
  // reach a session the store has never seen.
  const sessionFiles = new Map<string, string>()

  const spawnClient = (cwd?: string) => new OmpRpcClient({ command, args, cwd, env: options.env, spawn })

  const withProcessClient = async <T>(run: (client: OmpRpcClient) => Promise<T>, cwd?: string): Promise<T> => {
    const client = spawnClient(cwd)
    try {
      await client.start()
      return await run(client)
    } finally {
      await client.dispose()
    }
  }

  const findSession = async (id: string) => (await store.list()).find((session) => session.id === id)

  return {
    listSessions: () => store.list(),

    openSession: async (input) => {
      const client = spawnClient(input.cwd)
      await client.start()
      let state: { sessionId: string; sessionFile?: string }
      try {
        if (input.sessionPath) {
          const switched = await client.command<{ cancelled?: boolean } | undefined>("switch_session", { sessionPath: input.sessionPath })
          if (switched?.cancelled === true) throw new Error(`omp session switch was cancelled: ${input.sessionPath}`)
        }
        state = await client.command<{ sessionId: string; sessionFile?: string }>("get_state")
      } catch (error) {
        // Nothing references this process yet, so a failed handshake must kill it
        // or it is unreachable until the parent exits.
        await client.dispose()
        throw error
      }
      clients.set(state.sessionId, client)
      if (state.sessionFile) sessionFiles.set(state.sessionId, state.sessionFile)
      const listeners = new Set<(event: OmpEvent) => void>()
      client.onEvent((frame) => {
        for (const listener of listeners) listener(frame as OmpEvent)
      })
      const handle: OmpSessionHandle = {
        id: state.sessionId,
        prompt: async (text, options) => {
          const images = options?.images ?? []
          const result = await client.command<{ agentInvoked?: boolean } | undefined>("prompt", {
            message: text,
            // OMP reads an absent `images` and an empty one the same way; the
            // field is only written when there is something to carry.
            ...(images.length > 0 ? { images } : {}),
          })
          return result?.agentInvoked !== false
        },
        abort: async () => {
          await client.command("abort")
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose: async () => {
          clients.delete(state.sessionId)
          await client.dispose()
        },
        sessionFile: state.sessionFile,
        send: (frame) => {
          client.send(frame)
        },
        messages: async () => {
          const result = await client.command<{ messages: OmpMessage[] }>("get_messages")
          return result.messages
        },
      }
      return handle
    },

    renameSession: async (id, title) => {
      const open = clients.get(id)
      if (open) {
        await open.command("set_session_name", { name: title })
        return
      }
      const info = await findSession(id)
      if (!info) throw new Error(`unknown omp session: ${id}`)
      await withProcessClient(async (client) => {
        const switched = await client.command<{ cancelled?: boolean } | undefined>("switch_session", { sessionPath: info.sessionPath })
        if (switched?.cancelled === true) throw new Error(`omp session switch was cancelled: ${info.sessionPath}`)
        await client.command("set_session_name", { name: title })
      }, info.cwd)
    },

    deleteSession: async (id) => {
      const info = await findSession(id)
      const open = clients.get(id)
      const sessionFile = sessionFiles.get(id)
      clients.delete(id)
      sessionFiles.delete(id)
      if (open) await open.dispose()
      const target = info?.sessionPath ?? sessionFile
      if (!target) return Boolean(open)
      await store.delete(target)
      return true
    },

    moveSession: async (id, toDirectory) => {
      const info = await findSession(id)
      if (!info) throw new Error(`unknown omp session: ${id}`)
      await store.move(info.sessionPath, toDirectory)
    },

    setModel: async (id, provider, modelId) => {
      const open = clients.get(id)
      if (open) {
        await open.command("set_model", { provider, modelId })
        return
      }
      const info = await findSession(id)
      if (!info) throw new Error(`unknown omp session: ${id}`)
      await withProcessClient(async (client) => {
        const switched = await client.command<{ cancelled?: boolean } | undefined>("switch_session", { sessionPath: info.sessionPath })
        if (switched?.cancelled === true) throw new Error(`omp session switch was cancelled: ${info.sessionPath}`)
        await client.command("set_model", { provider, modelId })
      }, info.cwd)
    },

    listModels: () =>
      withProcessClient(async (client) => (await client.command<{ models: unknown[] }>("get_available_models")).models),

    listCommands: () =>
      withProcessClient(async (client) => (await client.command<{ commands: unknown[] }>("get_available_commands")).commands),

    listLoginProviders: () =>
      withProcessClient(async (client) => (await client.command<{ providers: OmpLoginProvider[] }>("get_login_providers")).providers),

    // Login is a long-lived flow: OMP keeps the process while it waits for the
    // browser callback, so this client outlives the call that needs it. Every
    // unsolicited frame is handed to the caller with a reply sink, because the
    // manual-code `input` prompt has to be answered on this same stdin.
    login: async (providerId, options) => {
      const client = spawnClient()
      const onFrame = options?.onFrame
      try {
        await client.start()
        if (onFrame) client.onEvent((frame) => onFrame(frame, (outbound) => client.send(outbound)))
        const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>()
        const timer = setTimeout(() => rejectTimeout(new OmpRpcError("login", `omp login timed out after ${LOGIN_TIMEOUT_MS}ms`)), LOGIN_TIMEOUT_MS)
        timer.unref?.()
        try {
          return await Promise.race([client.command<OmpLoginResult>("login", { providerId }), timeout])
        } finally {
          clearTimeout(timer)
        }
      } finally {
        await client.dispose()
      }
    },

    getSessionStatus: async (id) => {
      const client = clients.get(id)
      if (!client) return { busy: false }
      const state = await client.command<{ isStreaming?: boolean }>("get_state")
      return { busy: state.isStreaming === true }
    },
  }
}
