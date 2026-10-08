/**
 * The real OMP host: `omp --mode rpc` behind `OmpRuntime`.
 *
 * One RPC process per open session. `openSession` spawns, waits for `ready`,
 * optionally switches onto an on-disk session, then reads `get_state` for the
 * live id and session file. Events are forwarded verbatim; the caller owns
 * the projector. The host also keeps each session's unresolved askable frames
 * ('select'/'confirm'/'input'/'editor') so a caller can list and answer them,
 * and follows a `branch` to the new session id OMP swaps in place.
 *
 * Process-scoped commands that OMP only answers for the current session
 * (`get_available_models`, `get_available_commands`, and a rename of a session
 * that is not open) run on a short-lived process that is disposed right after,
 * so the long-lived per-session process count stays bounded.
 */

import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { OmpBranchCutError, resolveBranchEntry, type OmpBranchEntry } from "./branch-entry"
import { toOmpModelInfo } from "./mapping"
import { OmpRpcClient, OmpRpcError, type OmpRpcChild, type OmpRpcFrame, type OmpRpcSpawn } from "./rpc-client"
import { createSessionStore, parseSessionMessageEntries, type OmpSessionMessageEntry, type OmpSessionStore } from "./session-store"
import type { OmpMessage, OmpModelInfo, OmpThinkingLevel } from "./model"
import type {
  OmpContextUsage,
  OmpEvent,
  OmpHost,
  OmpLoginProvider,
  OmpLoginResult,
  OmpPendingRequest,
} from "./runtime"

export type OmpHostOptions = {
  command?: string
  args?: string[]
  env?: Record<string, string | undefined>
  spawn?: OmpRpcSpawn
  store?: OmpSessionStore
  /** Reads a session file for branch-cut resolution; injectable so tests need no real file. */
  readFile?: (file: string) => string
}

/** The `get_state` payload fields the host reads. */
type RpcSessionState = {
  sessionId?: string
  sessionFile?: string
  sessionName?: string
  isStreaming?: boolean
  isCompacting?: boolean
  queuedMessageCount?: number
  tokensPerSecond?: number | null
  contextUsage?: OmpContextUsage
}

/**
 * A live session's mutable identity. OMP's `branch` swaps the session inside
 * the same process, so the id and file are held here (not captured by value)
 * and the handle reads through them.
 */
type SessionHolder = { id: string; file?: string }

/** The `extension_ui_request` methods that expect an answer. */
const ASKABLE_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true }

/** Projects an askable `extension_ui_request` into the shape a caller lists and answers. */
const toPendingRequest = (sessionId: string, frame: OmpRpcFrame): OmpPendingRequest => ({
  requestId: String(frame.id),
  sessionId,
  method: frame.method as OmpPendingRequest["method"],
  title: typeof frame.title === "string" ? frame.title : "",
  ...(Array.isArray(frame.options) ? { options: frame.options.filter((option): option is string => typeof option === "string") } : {}),
  ...(Array.isArray(frame.optionDetails) ? { optionDetails: frame.optionDetails as { description?: string }[] } : {}),
  ...(typeof frame.message === "string" ? { message: frame.message } : {}),
  ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
  ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
})

/** Records an ask OMP is waiting on, and drops the one a `cancel` frame supersedes. */
const trackPending = (pending: Map<string, OmpPendingRequest>, holder: SessionHolder, frame: OmpRpcFrame): void => {
  if (frame.type !== "extension_ui_request" || typeof frame.id !== "string") return
  if (frame.method === "cancel") {
    if (typeof frame.targetId === "string") pending.delete(frame.targetId)
    return
  }
  if (typeof frame.method !== "string" || ASKABLE_METHODS[frame.method] !== true) return
  pending.set(frame.id, toPendingRequest(holder.id, frame))
}

/** Drops the ask the reply frame answers, so a listed form is never already handled. */
const forgetAnswered = (pending: Map<string, OmpPendingRequest>, frame: OmpRpcFrame): void => {
  if (frame.type === "extension_ui_response" && typeof frame.id === "string") pending.delete(frame.id)
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

/**
 * A session's own directory is gone — a deleted project, a moved folder, a temp
 * directory that was cleaned up.
 *
 * OMP starts an agent in the session's directory, and it refuses to move a
 * process to a different one (`switch_session` answers `{ cancelled: true }`,
 * verified against the pinned CLI). So a session whose directory no longer
 * exists cannot be opened at all: there is no directory to start in, and no
 * other directory OMP would accept. This error names that, because the raw
 * failure Node produces for a missing working directory — `ENOENT: no such file
 * or directory, posix_spawn 'omp'` — reads as a missing agent binary, and is not
 * one.
 */
export class OmpSessionDirectoryMissingError extends Error {
  readonly code = "session_directory_missing"
  readonly directory: string
  constructor(directory: string) {
    super(`This session's folder no longer exists: ${directory}. OMP cannot open a session whose folder is gone.`)
    this.name = "OmpSessionDirectoryMissingError"
    this.directory = directory
  }
}

/** A cwd has to be a directory that exists; a missing one makes Node blame the command. */
const isExistingDirectory = (directory: string): boolean => {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}

export const createOmpHost = (options: OmpHostOptions = {}): OmpHost => {
  const command = options.command ?? resolveOmpCommand({ env: options.env })
  const args = options.args ?? ["--mode", "rpc"]
  const spawn = options.spawn ?? defaultSpawn
  const store = options.store ?? createSessionStore()
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"))
  const clients = new Map<string, OmpRpcClient>()
  // OMP creates a session's file lazily, so a just-created session is not in the
  // store yet. The live process reports its `sessionFile`; keep it so delete can
  // reach a session the store has never seen.
  const sessionFiles = new Map<string, string>()
  // The live id and file are held in a mutable holder per open process, because
  // `branch` swaps the session in place and the handle must read the new id.
  const holders = new Map<string, SessionHolder>()
  // Askable frames OMP is still waiting on, keyed by the current session id.
  const pendings = new Map<string, Map<string, OmpPendingRequest>>()

  const spawnClient = (cwd?: string) => {
    // Node reports a missing working directory as `ENOENT … posix_spawn
    // '<command>'`, which blames the binary. Name the real cause instead of
    // letting that reach the caller.
    if (cwd !== undefined && !isExistingDirectory(cwd)) throw new OmpSessionDirectoryMissingError(cwd)
    return new OmpRpcClient({ command, args, cwd, env: options.env, spawn })
  }

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

  const requireClient = (id: string): OmpRpcClient => {
    const client = clients.get(id)
    if (!client) throw new Error(`omp session is not open: ${id}`)
    return client
  }

  /**
   * The OMP entry id the caller's cut names. The cut is a canonical
   * `Message.id`, not a session-file entry id, so it is translated against the
   * live session: `get_branch_messages` names the user entries OMP accepts and
   * the session file maps a projected timestamp onto its entry id. A cut that
   * resolves to nothing rejects with a message naming it rather than OMP's own
   * refusal, which cannot say what the cut was.
   */
  const resolveBranchCut = async (client: OmpRpcClient, holder: SessionHolder, cut: string): Promise<string> => {
    const branchable = await client.command<{ messages: OmpBranchEntry[] }>("get_branch_messages")
    let entries: OmpSessionMessageEntry[] = []
    if (holder.file) {
      try {
        entries = parseSessionMessageEntries(readFile(holder.file))
      } catch {
        // A session whose file is not readable yet still resolves a cut that is
        // already a real entry id; a projected one reports as unresolvable.
        entries = []
      }
    }
    try {
      return resolveBranchEntry(cut, entries, branchable.messages ?? [])
    } catch (error) {
      if (error instanceof OmpBranchCutError) throw new OmpRpcError("branch", error.message)
      throw error
    }
  }

  return {
    listSessions: () => store.list(),

    openSession: async (input) => {
      const client = spawnClient(input.cwd)
      await client.start()
      let state: RpcSessionState
      try {
        if (input.parentSession) {
          // Record the parent on the new session's header — the field the store
          // reads back as `parentSessionPath`.
          const created = await client.command<{ cancelled?: boolean } | undefined>("new_session", { parentSession: input.parentSession })
          if (created?.cancelled === true) throw new Error(`omp new_session was cancelled: ${input.parentSession}`)
        }
        if (input.sessionPath) {
          const switched = await client.command<{ cancelled?: boolean } | undefined>("switch_session", { sessionPath: input.sessionPath })
          if (switched?.cancelled === true) throw new Error(`omp session switch was cancelled: ${input.sessionPath}`)
        }
        state = await client.command<RpcSessionState>("get_state")
      } catch (error) {
        // Nothing references this process yet, so a failed handshake must kill it
        // or it is unreachable until the parent exits.
        await client.dispose()
        throw error
      }
      if (typeof state.sessionId !== "string") {
        await client.dispose()
        throw new Error("omp did not report a session id")
      }
      const holder: SessionHolder = { id: state.sessionId, file: state.sessionFile }
      holders.set(holder.id, holder)
      clients.set(holder.id, client)
      if (holder.file) sessionFiles.set(holder.id, holder.file)
      const listeners = new Set<(event: OmpEvent) => void>()
      const pending = new Map<string, OmpPendingRequest>()
      pendings.set(holder.id, pending)
      client.onEvent((frame) => {
        trackPending(pending, holder, frame)
        for (const listener of listeners) listener(frame as OmpEvent)
      })
      return {
        get id() {
          return holder.id
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
          clients.delete(holder.id)
          holders.delete(holder.id)
          sessionFiles.delete(holder.id)
          pendings.delete(holder.id)
          await client.dispose()
        },
        get sessionFile() {
          return holder.file
        },
        send: (frame) => {
          forgetAnswered(pending, frame)
          client.send(frame)
        },
        messages: async () => {
          const result = await client.command<{ messages: OmpMessage[] }>("get_messages")
          return result.messages
        },
      }
    },

    prompt: async (id, text, options) => {
      const client = requireClient(id)
      const images = options?.images ?? []
      const result = await client.command<{ agentInvoked?: boolean } | undefined>("prompt", {
        message: text,
        // OMP reads an absent `images` and an empty one the same way; the
        // field is only written when there is something to carry.
        ...(images.length > 0 ? { images } : {}),
      })
      return result?.agentInvoked !== false
    },

    /**
     * Branches at `entryId`. `entryId` is the caller's transcript cut (a
     * canonical `Message.id`), resolved to the OMP entry the session has; a cut
     * that names no branchable user entry rejects with a message naming it. OMP
     * swaps the live session inside this process when the branch starts a new
     * file, so the host follows the new id from `get_state`; an unknown entry
     * rejects with OMP's own message and leaves the session untouched.
     */
    branch: async (id, entryId) => {
      const client = requireClient(id)
      const holder = holders.get(id)
      if (!holder) throw new OmpRpcError("branch", `omp session is not open: ${id}`)
      const target = await resolveBranchCut(client, holder, entryId)
      const result = await client.command<{ cancelled?: boolean } | undefined>("branch", { entryId: target })
      if (result?.cancelled === true) throw new OmpRpcError("branch", "omp branch was cancelled")
      const state = await client.command<RpcSessionState>("get_state")
      if (typeof state.sessionId !== "string") throw new OmpRpcError("branch", "omp branch reported no session")
      const from = holder.id
      if (from !== state.sessionId) {
        clients.delete(from)
        holders.delete(from)
        sessionFiles.delete(from)
        const pending = pendings.get(from)
        if (pending) {
          pendings.delete(from)
          pendings.set(state.sessionId, pending)
        }
      }
      holder.id = state.sessionId
      holder.file = state.sessionFile
      clients.set(holder.id, client)
      holders.set(holder.id, holder)
      if (holder.file) sessionFiles.set(holder.id, holder.file)
      return { id: holder.id, sessionPath: holder.file ?? "", cwd: "", title: state.sessionName ?? "" }
    },

    setThinkingLevel: async (id, level) => {
      await requireClient(id).command("set_thinking_level", { level })
      return true
    },

    cycleThinkingLevel: async (id) => {
      const result = await requireClient(id).command<{ level?: OmpThinkingLevel } | null>("cycle_thinking_level")
      return result?.level ?? null
    },

    setFastMode: async (id, enabled) => {
      const result = await requireClient(id).command<{ enabled?: boolean; active?: boolean }>("set_fast_mode", { enabled })
      return { enabled: result?.enabled === true, active: result?.active === true }
    },

    listPendingRequests: (id) => [...(pendings.get(id)?.values() ?? [])],

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
      holders.delete(id)
      pendings.delete(id)
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
      withProcessClient(async (client) =>
        (await client.command<{ models: unknown[] }>("get_available_models")).models.map(toOmpModelInfo),
      ),

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
      if (!client) return { busy: false, compacting: false, queuedCount: 0, tokensPerSecond: null, contextUsage: null }
      const state = await client.command<RpcSessionState>("get_state")
      return {
        // A compactor is a running turn: a session that is compacting while not
        // streaming still must queue the next send.
        busy: state.isStreaming === true || state.isCompacting === true,
        compacting: state.isCompacting === true,
        queuedCount: state.queuedMessageCount ?? 0,
        tokensPerSecond: state.tokensPerSecond ?? null,
        contextUsage: state.contextUsage ?? null,
      }
    },
  }
}
