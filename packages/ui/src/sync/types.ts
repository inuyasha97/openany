import type {
  Agent,
  FormRequest,
  Message,
  Part,
  PermissionRequest,
  Project,
  Session,
  SessionStatus,
  Vcs,
} from "@/lib/opencode/model"

export type { Project }

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  session: Session[]
  sessionTotal: number
  sessionListSource?: "empty" | "persisted" | "live" | "authoritative"
  sessionRevision?: number
  sessionEventRevision?: Record<string, number>
  sessionDeletedRevision?: Record<string, number>
  session_status: Record<string, SessionStatus>
  /** A successful status snapshot makes omitted sessions authoritatively idle. */
  sessionStatusReady?: boolean
  /** Archive evicts a session's status; the earlier snapshot no longer covers it. */
  sessionStatusInvalidated?: Record<string, true>
  permission: Record<string, PermissionRequest[]>
  /** Pending forms (the agent asking the user for input), keyed by session. */
  form: Record<string, FormRequest[]>
  vcs: Vcs | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  reload: undefined | "pending" | "complete"
}

type InitError = {
  type: "init"
  message: string
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  graceMs?: number
  now: number
  hasPendingBlockingRequests?: (directory: string) => boolean
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
  hasPendingBlockingRequests: boolean
}

export const MAX_DIR_STORES = 30
/**
 * Directories touched within this window are never overflow-eviction victims.
 *
 * Sidebar rows call `ensureChild` during render but only take their pin in an
 * effect after commit. Without a grace window, expanding a project with more
 * worktrees than `MAX_DIR_STORES` evicted directories that were actively
 * rendering, which recreated them, which issued another bootstrap request, in
 * an endless loop (issue #1472). The limit is therefore a soft target: a burst
 * of live directories overflows briefly rather than thrashing, and the cache is
 * bounded by idle-time eviction instead.
 */
export const EVICTION_GRACE_MS = 30 * 1000
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 20

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  status: "loading",
  agent: [],
  session: [],
  sessionTotal: 0,
  sessionListSource: "empty",
  sessionRevision: 0,
  sessionEventRevision: {},
  sessionDeletedRevision: {},
  session_status: {},
  permission: {},
  form: {},
  vcs: undefined,
  limit: 5,
  message: {},
  part: {},
}

export const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  reload: undefined,
}
