import { openChamberClient } from "@/lib/openchamber/client"
import { getAgentRuntime } from "@/lib/agent/registry"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"
import { runtimeFetch } from "../lib/runtime-fetch"
import { warmChatsRootDirectory } from "../lib/chatDirectories"
import { runBackgroundNetworkTask } from "../lib/background-network"
import {
  readDirectoryStatusSnapshot,
  readDirectoryPermissionSnapshot,
  type DirectoryRecoverySource,
} from "./directory-recovery-snapshots"

// ---------------------------------------------------------------------------
// Bootstrap global state
// ---------------------------------------------------------------------------

export async function bootstrapGlobal(set: (patch: Partial<GlobalState>) => void) {
  const results = await Promise.allSettled([
    // Sync chat classification needs the chats root before session lists load;
    // it resolves alongside the readiness probe, not ahead of it.
    warmChatsRootDirectory(),
    // The server's own health is the readiness gate: nothing below can succeed
    // while it is unreachable, and a reachable server answers `ok` even before
    // the agent runtime is up.
    retry(async () => {
      if (!(await openChamberClient.checkHealth())) throw new Error("OpenChamber server is not ready")
    }),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error("[bootstrap] global bootstrap failed", errors[0])
  }

  // If everything failed, the server itself is likely down — re-read the
  // health endpoint (outside the readiness gate) for the reason it reports.
  if (errors.length === results.length) {
    let message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    try {
      const healthRes = await runtimeFetch("/health", { signal: AbortSignal.timeout(4000) })
      if (healthRes.ok) {
        const health = await healthRes.json()
        if (typeof health.lastOpenCodeError === "string" && health.lastOpenCodeError) {
          message = health.lastOpenCodeError
        } else if (health.openCodeRunning === false) {
          message = "Agent runtime is not running"
        }
      }
    } catch {
      // health endpoint itself unreachable — use the original error
    }
    set({ ready: true, error: { type: "init", message } })
  } else {
    set({ ready: true, error: undefined })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap per-directory state
// ---------------------------------------------------------------------------

type DirectoryBootstrapInput = {
  directory: string
  store: DirectoryRecoverySource
  set: (patch: Partial<State>) => void
  isStale?: () => boolean
  loadSessions: (directory: string) => Promise<void> | void
}

type BootstrapResult = "complete" | "failed" | "stale"

export function bootstrapDirectory(input: DirectoryBootstrapInput) {
  const sessions = (async (): Promise<BootstrapResult> => {
    if (input.isStale?.()) return "stale"
    try {
      await input.loadSessions(input.directory)
      return input.isStale?.() ? "stale" : "complete"
    } catch (error) {
      if (input.isStale?.()) return "stale"
      console.error(`[bootstrap] session load failed for ${input.directory}`, error)
      return "failed"
    }
  })()
  // Initialization has its own completion and network capacity. A slow
  // directory cannot hold the session-list scheduler's slot.
  const environment = initializeDirectory(input)
  return { sessions, environment }
}

async function initializeDirectory(input: DirectoryBootstrapInput): Promise<BootstrapResult> {
  const { directory, store, set } = input
  const read = <T>(request: () => Promise<T>) => retry(() => runBackgroundNetworkTask(() => {
    if (input.isStale?.()) throw new Error("Directory initialization superseded")
    return request()
  }))
  const commit = (patch: Partial<State>): boolean => {
    if (input.isStale?.()) return false
    set(patch)
    return true
  }

  commit({ status: "partial" })
  if (input.isStale?.()) return "stale"

  // Each read commits independently, so one failing read cannot suppress the
  // pending form or permission recovery.
  const critical = Promise.allSettled([
    read(async () => {
      const session_status = await readDirectoryStatusSnapshot(store, async () => {
        const statuses = await getAgentRuntime().getActiveStatus(directory)
        if (statuses === null) throw new Error("session.active failed")
        return statuses
      })
      commit({ session_status, sessionStatusReady: true })
    }),
    read(async () => {
      const permission = await readDirectoryPermissionSnapshot(store, () => (
        getAgentRuntime().listPermissions({ directories: [directory], includeGlobal: false })
      ))
      commit({ permission })
    }),
  ])
  // MCP status and the command list are deliberately not read here. Reading
  // MCP state initializes the directory's whole stdio server fleet as a side
  // effect, and listing commands enumerates MCP prompts, which touches that
  // same state. Both surfaces fetch on demand through their own stores
  // (useMcpStore, useCommandsStore) instead.
  const results = await critical
  if (input.isStale?.()) return "stale"
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (errors.length) {
    console.error(`[bootstrap] environment initialization failed for ${directory}`, errors[0].reason)
    return "failed"
  }
  commit({ status: "complete" })
  return "complete"
}
