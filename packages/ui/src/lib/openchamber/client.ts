/**
 * OpenChamber client.
 *
 * The OpenChamber-owned surface the shared UI depends on: the directory
 * cursor, the server's filesystem routes (`/api/fs/*`, `/api/opencode/directory`),
 * the host's session-status snapshots, the runtime transport, and the server's
 * own health. Every call goes through `runtimeFetch`, so it follows the active
 * runtime's URL, credentials and relay.
 *
 * Agent-domain calls (sessions, messages, permissions, commands, models) are
 * NOT here: they go through `@/lib/agent/registry`.
 */

import { z } from "zod"
import type { FilesAPI } from "../api/types"
import { getDesktopHomeDirectory } from "../desktop"
import { FilesystemError, parseFilesystemErrorReason } from "@/lib/api/files-errors"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { markStartupTrace } from "@/lib/startupTrace"
import { normalizePath } from "@/lib/pathNormalization"
import { hostSessionStatusSnapshotSchema, type HostSessionStatusSnapshot } from "@/lib/opencode/session-status"

export { OpencodeApiError, isOpencodeNotFound, normalizeOpencodeError } from "./errors"

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api"
const HEALTH_TIMEOUT_MS = 4_000
const FS_LIST_CACHE_TTL_MS = 400

export type OpencodeHealthProbe = "healthy" | "unhealthy" | "unreachable"

export type FilesystemEntry = {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink?: boolean
}

export type DirectoryAvailability = "available" | "missing" | "unknown"

// ---------------------------------------------------------------------------
// Ids and URLs
// ---------------------------------------------------------------------------

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//
const ensureAbsoluteBaseUrl = (candidate: string): string => {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api"

  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized
  }

  if (typeof window === "undefined") {
    return normalized
  }

  const baseReference = window.location?.href || window.location?.origin
  if (!baseReference) {
    return normalized
  }

  try {
    return new URL(normalized, baseReference).toString()
  } catch (error) {
    console.warn("Failed to normalize OpenChamber base URL:", error)
    return normalized
  }
}

const resolveRuntimeBaseUrl = (): string | null => {
  try {
    return getRuntimeUrlResolver().api("/api")
  } catch {
    return null
  }
}

type AbortSignalConstructorWithTimeout = typeof AbortSignal & {
  timeout?: (milliseconds: number) => AbortSignal
}

const createTimeoutSignal = (timeoutMs: number): { signal: AbortSignal; cleanup: () => void } => {
  const abortSignal = typeof AbortSignal !== "undefined" ? (AbortSignal as AbortSignalConstructorWithTimeout) : undefined
  if (typeof abortSignal?.timeout === "function") {
    return { signal: abortSignal.timeout(timeoutMs), cleanup: () => undefined }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  }
}

const directoryProbeErrorSchema = z.object({ reason: z.string().optional(), isDirectory: z.boolean().optional() })

const normalizeFsPath = (path: string): string => path.replace(/\\/g, "/")

const getDesktopFilesApi = (): FilesAPI | null => {
  const apis = getRegisteredRuntimeAPIs()
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files
  }
  return null
}

// /api/fs/home parsing boundary. Older servers answer without chatsRoot;
// only a valid home response may use the legacy chats-root fallback.
const fsAbsolutePathSchema = z.string().trim().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
const fsHomeResponseSchema = z.object({
  home: fsAbsolutePathSchema,
  chatsRoot: fsAbsolutePathSchema.optional(),
  canonicalChatsRoot: fsAbsolutePathSchema.optional(),
  canonicalLegacyChatsRoot: fsAbsolutePathSchema.optional(),
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class OpenChamberService {
  private baseUrl: string
  /** Bumped whenever the transport is rebound; sync layers use it as an identity token. */
  private connectionEpoch = 0
  private currentDirectory: string | undefined = undefined
  private directoryContextQueue: Promise<void> = Promise.resolve()
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map()
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map()

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const runtimeBase = resolveRuntimeBaseUrl()
    this.baseUrl = ensureAbsoluteBaseUrl(runtimeBase || baseUrl)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  /**
   * Identity of the current runtime binding: the runtime key plus the
   * transport epoch. It changes both when the runtime endpoint moves and when
   * the transport behind the same key is rebound, so a caller holding
   * in-flight work can tell the binding it started under is gone.
   */
  getRuntimeIdentity(): string {
    return `${getRuntimeKey()}#${this.connectionEpoch}`
  }

  reconnectToRuntimeBaseUrl(): void {
    const runtimeBase = resolveRuntimeBaseUrl()
    const nextBaseUrl = ensureAbsoluteBaseUrl(runtimeBase || DEFAULT_BASE_URL)
    // An explicit reconnect can change the instance or transport behind the
    // same URL. Its in-flight directory requests are obsolete.
    this.baseUrl = nextBaseUrl
    this.connectionEpoch += 1
    this.listDirectoryInFlight.clear()
    this.listDirectoryCache.clear()
  }

  private normalizeCandidatePath(path?: string | null): string | null {
    return normalizePath(path)
  }

  private deriveHomeDirectory(path: string): { homeDirectory: string; username?: string } {
    const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/)
    if (windowsMatch) {
      const drive = windowsMatch[1]
      const remainder = path.slice(drive.length + (path.charAt(drive.length) === "/" ? 1 : 0))
      const segments = remainder.split("/").filter(Boolean)

      if (segments.length >= 2) {
        const homeDirectory = `${drive}/${segments[0]}/${segments[1]}`
        return { homeDirectory, username: segments[1] }
      }

      if (segments.length === 1) {
        const homeDirectory = `${drive}/${segments[0]}`
        return { homeDirectory, username: segments[0] }
      }

      return { homeDirectory: `${drive}/`, username: undefined }
    }

    const absolute = path.startsWith("/")
    const segments = path.split("/").filter(Boolean)

    if (segments.length >= 2 && (segments[0] === "Users" || segments[0] === "home")) {
      const homeDirectory = `${absolute ? "/" : ""}${segments[0]}/${segments[1]}`
      return { homeDirectory, username: segments[1] }
    }

    if (absolute) {
      if (segments.length === 0) {
        return { homeDirectory: "/", username: undefined }
      }
      const homeDirectory = `/${segments.join("/")}`
      return { homeDirectory, username: segments[segments.length - 1] }
    }

    if (segments.length > 0) {
      const homeDirectory = `/${segments.join("/")}`
      return { homeDirectory, username: segments[segments.length - 1] }
    }

    return { homeDirectory: "/", username: undefined }
  }

  // Set the current working directory for all API calls
  setDirectory(directory: string | undefined) {
    const normalized = this.normalizeCandidatePath(directory) ?? directory
    if (this.currentDirectory !== normalized) {
      markStartupTrace("openChamberClient:setDirectory", {
        previous: this.currentDirectory ?? null,
        next: normalized ?? null,
      })
    }
    this.currentDirectory = normalized
  }

  getDirectory(): string | undefined {
    return this.currentDirectory
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const runWithContext = async (): Promise<T> => {
      if (directory === undefined || directory === null) {
        return fn()
      }

      const previousDirectory = this.currentDirectory
      const scopedDirectory = this.normalizeCandidatePath(directory) ?? directory
      this.currentDirectory = scopedDirectory
      try {
        return await fn()
      } finally {
        if (this.currentDirectory === scopedDirectory) {
          this.currentDirectory = previousDirectory
        }
      }
    }

    const queuedRun = this.directoryContextQueue.then(runWithContext, runWithContext)
    this.directoryContextQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    )

    return queuedRun
  }

  /**
   * The home directory the server reports, plus a username derived from it.
   * Callers that only need the path use {@link getFilesystemHome}.
   */
  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates = new Set<string>()
    const addCandidate = (value?: string | null) => {
      const normalized = this.normalizeCandidatePath(value)
      if (normalized) {
        candidates.add(normalized)
      }
    }

    addCandidate(await this.getFilesystemHome())
    addCandidate(this.currentDirectory)

    if (typeof window !== "undefined") {
      try {
        addCandidate(window.localStorage.getItem("lastDirectory"))
        addCandidate(window.localStorage.getItem("homeDirectory"))
      } catch {
        // Access to storage failed (e.g. privacy mode)
      }
    }

    if (!candidates.size && typeof process !== "undefined" && typeof process.cwd === "function") {
      addCandidate(process.cwd())
    }

    if (!candidates.size) {
      return { homeDirectory: "/", username: undefined }
    }

    const [primary] = Array.from(candidates)
    return this.deriveHomeDirectory(primary)
  }

  /**
   * Best-effort probe whether a directory is accessible to the server.
   * This is intentionally NOT the same as local filesystem access in the UI runtime.
   */
  async probeDirectory(directory: string): Promise<boolean> {
    return (await this.getDirectoryAvailability(directory)) === "available"
  }

  /**
   * Distinguishes a confirmed-missing directory from an unavailable probe.
   * Offline, permission, and other transport failures stay `unknown` so callers
   * do not treat a temporary outage as proof the path was deleted.
   *
   * The probe is OpenChamber's own `/api/fs/directory-stat`, which asks the
   * server to stat the path without listing its contents. A runtime without
   * that route (VS Code) answers `unknown`.
   */
  async getDirectoryAvailability(directory: string): Promise<DirectoryAvailability> {
    const normalized = this.normalizeCandidatePath(directory)
    if (!normalized) {
      return "unknown"
    }
    try {
      const response = await runtimeFetch("/api/fs/directory-stat", { query: { path: normalized } })
      const body = directoryProbeErrorSchema.safeParse(await response.json().catch(() => null)).data
      if (response.ok && body?.isDirectory === true) return "available"
      const reason = parseFilesystemErrorReason(body?.reason)
      return reason === "not-found" || reason === "not-directory" ? "missing" : "unknown"
    } catch {
      return "unknown"
    }
  }

  /**
   * Cross-project busy/retry/idle map kept by the OpenChamber host from the
   * single upstream event stream. `null` means the fetch failed; callers must
   * preserve their current state.
   */
  async getHostSessionStatusSnapshot(): Promise<HostSessionStatusSnapshot | null> {
    try {
      const response = await runtimeFetch('/api/sessions/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const parsed = hostSessionStatusSnapshotSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Get session activity from web server's in-memory tracking.
   * This is more reliable than a per-runtime active list on visibility restore
   * because the web server tracks activity even when UI is not listening to SSE.
   */
  async getWebServerSessionActivity(): Promise<Record<string, { type: string }> | null> {
    try {
      const response = await runtimeFetch("/api/session-activity", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json().catch(() => null)
      if (!data || typeof data !== "object") {
        return null
      }

      return data as Record<string, { type: string }>
    } catch {
      return null
    }
  }

  // Lightweight readiness check. Full diagnostics still live at /health.
  async checkHealth(): Promise<boolean> {
    return (await this.probeHealth()) === "healthy"
  }

  /**
   * Classifies the OpenChamber server's own health probe. "unreachable" means
   * the server did not answer (network error or timeout); "unhealthy" means it
   * answered but did not report itself ready.
   */
  async probeHealth(): Promise<OpencodeHealthProbe> {
    markStartupTrace("openChamberClient.checkHealth:url", { baseUrl: this.baseUrl })
    let response: Response
    try {
      const timeout = createTimeoutSignal(HEALTH_TIMEOUT_MS)
      response = await runtimeFetch("/health", { signal: timeout.signal }).finally(timeout.cleanup)
    } catch {
      return "unreachable"
    }
    markStartupTrace("openChamberClient.checkHealth:response", { status: response.status })
    // A gateway error means a proxy answered for a server it could not reach.
    if (response.status === 502 || response.status === 504) {
      return "unreachable"
    }
    if (!response.ok) {
      return "unhealthy"
    }
    try {
      const healthData = await response.json()
      markStartupTrace("openChamberClient.checkHealth:result", { status: healthData?.status })
      return healthData?.status === "ok" ? "healthy" : "unhealthy"
    } catch {
      return "unhealthy"
    }
  }

  // -------------------------------------------------------------------------
  // File System Operations (OpenChamber routes)
  // -------------------------------------------------------------------------

  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean; asProject?: boolean },
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi()
    if (desktopFiles?.createDirectory) {
      try {
        return await desktopFiles.createDirectory(dirPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message || "Failed to create directory")
      }
    }

    if (options?.asProject) {
      const response = await runtimeFetch(`${this.baseUrl}/opencode/directory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: dirPath, create: true }),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to create project directory" }))
        throw new Error(error.error || "Failed to create project directory")
      }

      const result = await response.json()
      return { success: true, path: result.path }
    }

    const payload = {
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    }

    const response = await runtimeFetch(`${this.baseUrl}/fs/mkdir`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to create directory" }))
      throw new Error(error.error || "Failed to create directory")
    }

    const result = await response.json()
    return result
  }

  async cloneRepository(input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null }): Promise<{ success: boolean; path: string; output?: string }> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/clone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to clone repository" }))
      throw new Error(error.error || "Failed to clone repository")
    }

    return await response.json()
  }

  async listLocalDirectory(directoryPath: string | null | undefined, options?: { respectGitignore?: boolean }): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === "string" ? normalizeFsPath(directoryPath.trim()) : ""
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? "1" : "0"}`
    const now = Date.now()
    const cached = this.listDirectoryCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached.entries
    }

    const inFlight = this.listDirectoryInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    const task = (async () => {
      const desktopFiles = getDesktopFilesApi()
      try {
        if (desktopFiles) {
          const result = await desktopFiles.listDirectory(directoryPath || "", options)
          if (!result || !Array.isArray(result.entries)) {
            throw new FilesystemError("Directory listing returned an invalid response", {
              reason: "invalid-response",
            })
          }
          const entries = result.entries.map<FilesystemEntry>((entry) => ({
            name: entry.name,
            path: normalizeFsPath(entry.path),
            isDirectory: !!entry.isDirectory,
            isFile: !entry.isDirectory,
            isSymbolicLink: false,
          }))
          this.listDirectoryCache.set(cacheKey, {
            entries,
            expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
          })
          return entries
        }

        const params = new URLSearchParams()
        if (directoryPath && directoryPath.trim().length > 0) {
          params.set("path", directoryPath)
        }
        if (options?.respectGitignore) {
          params.set("respectGitignore", "true")
        }
        const query = params.toString()
        const response = await runtimeFetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ""}`)
        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          const message = typeof error.error === "string" ? error.error : "Failed to list directory"
          throw new FilesystemError(message, {
            reason: parseFilesystemErrorReason((error as { reason?: unknown }).reason),
            status: response.status,
          })
        }

        const result = await response.json()
        if (!result || !Array.isArray(result.entries)) {
          throw new FilesystemError("Directory listing returned an invalid response", {
            reason: "invalid-response",
          })
        }

        const entries = result.entries as FilesystemEntry[]
        this.listDirectoryCache.set(cacheKey, {
          entries,
          expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
        })
        return entries
      } catch (error) {
        console.error("Failed to list directory contents:", error)
        throw error
      }
    })()

    const trackedTask = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === trackedTask) {
        this.listDirectoryInFlight.delete(cacheKey)
      }
    })
    this.listDirectoryInFlight.set(cacheKey, trackedTask)
    return trackedTask
  }

  async getFilesystemHome(): Promise<string | null> {
    // The injected desktop home describes the LOCAL machine. It is only a
    // valid answer while the active runtime is the local one — after an
    // in-place switch to a remote host the home must come from that host's
    // /api/fs/home, not from the local Electron global.
    const runtimeKey = getRuntimeKey()
    if (!runtimeKey || runtimeKey === "local") {
      const desktopHome = await getDesktopHomeDirectory()
      if (desktopHome) {
        return desktopHome
      }
    }

    try {
      const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        const message =
          typeof error.error === "string" && error.error.length > 0 ? error.error : "Failed to resolve home directory"
        throw new Error(message)
      }

      const payload = await response.json()
      if (payload && typeof payload.home === "string" && payload.home.length > 0) {
        return payload.home
      }
      return null
    } catch (error) {
      console.warn("Failed to resolve filesystem home directory:", error)
      return null
    }
  }

  // Both roots must describe the same server response, including on desktop.
  // Failure is distinct from an older server omitting chatsRoot.
  async getFilesystemHomeInfo(): Promise<z.infer<typeof fsHomeResponseSchema>> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })
    if (!response.ok) {
      throw new Error(`Failed to resolve the chats root (${response.status})`)
    }
    return fsHomeResponseSchema.parse(await response.json())
  }
}

// Exported singleton instance
export const openChamberClient = new OpenChamberService()
