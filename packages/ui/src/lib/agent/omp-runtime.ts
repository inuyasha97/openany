/**
 * OMP agent runtime client.
 *
 * Implements the `AgentRuntime` contract over the OMP server routes
 * (`packages/web/server/lib/agents/`) and the `openchamber:omp` bridge frame.
 * OMP supports sessions, prompts and cancels; every other contract method is
 * declared unsupported and rejects, so a caller gated by `capabilities` never
 * reaches it, and a caller that does gets a clear failure rather than a silent
 * empty result.
 *
 * Events do not flow through `translateEvent`: the server projects OMP events
 * into canonical `SyncEvent`s and pushes them on the shared bridge, which the
 * event pipeline routes. `translateEvent` therefore handles no wire payload.
 */

import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { FileDiffInfo, FormAnswer, FormInfo, SessionRevert } from "@/lib/opencode/wire"
import type {
  Agent,
  Command,
  McpServerStatus,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  SessionStatus,
  Skill,
} from "@/lib/opencode/model"
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  CreateSessionParams,
  FetchPermissionResult,
  FileInputLite,
  MessagePage,
  MoveSessionOptions,
  PendingRequestListOptions,
  SendCommandParams,
  SendPromptParams,
  SessionListOptions,
  SessionPage,
} from "./contract"
import type { RoutedAgentEvent } from "./events"

const CAPABILITIES: AgentCapabilities = {
  // `branch { entryId }` forks the transcript; `new_session { parentSession }`
  // links the fork to its parent.
  fork: true,
  commands: true,
  mcp: true,
  // OMP discovers agent markdown files (`<agent dir>/agents`, project
  // `.omp/agents`) and the server lists them, so the Agents page and the
  // composer's defaults have a catalog. It still picks a subagent inside the
  // model's own `task` call, so `agentSelection` stays false: there is no
  // session agent to switch.
  agents: true,
  permissions: true,
  modelSelection: true,
  agentSelection: false,
  // The model's `ask` tool reaches the host as `extension_ui_request` frames,
  // which the server projects as forms (see `listPendingForms`/`replyForm`).
  forms: true,
  // OMP keeps no file snapshots: `branch` forks the transcript, not the files,
  // and there is no per-turn diff API. Both stay false so no affordance
  // promises a revert or a turn diff OMP cannot produce.
  revert: false,
  turnDiff: false,
  skills: true,
  rename: true,
  delete: true,
  move: true,
  attachments: true,
  // OMP takes images inline and every other file only as an `@path` mention
  // resolved against the session directory. A picked file has no path, so the
  // composer offers images alone; anything else is sent by mentioning it.
  attachmentKinds: "images",
}

/** One image OMP accepts on a prompt: base64 payload plus its MIME type. */
export type OmpPromptImage = { type: "image"; data: string; mimeType: string }

/** What OMP's `prompt` command takes (`modes/rpc/rpc-types.ts`). */
export type OmpPromptBody = { text: string; messageId?: string; images?: OmpPromptImage[] }

const BASE64_DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/
const FILE_URL_PREFIX = "file://"
const MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g
const MENTION_BOUNDARY = /[\s([{<"'`]/
const MENTION_TRIM = /[)\]}>.,;:!?"'`]+$/

/**
 * The filesystem path a `file://` attachment URL addresses. Composer
 * attachments are stored as `file://` URLs (`toServerFileUrl`), which is the
 * only representation that carries a path a runtime can read.
 */
const filePathFromUrl = (url: string): string | null => {
  if (!url.startsWith(FILE_URL_PREFIX)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(url.slice(FILE_URL_PREFIX.length))
  } catch {
    return null
  }
  // `C:/x` is encoded as `file:///C:/x`; the added root slash is not part of it.
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
}

/**
 * Whether the prompt text already carries this path as a mention, in OMP's own
 * syntax. A mention the user typed is project-relative while an attachment
 * carries the absolute path, so either form counts as a match: re-appending it
 * would make OMP read the same file twice.
 */
const isAlreadyMentioned = (text: string, path: string): boolean => {
  const normalize = (value: string): string =>
    value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/+$/, "")
  const target = normalize(path)
  for (const match of text.matchAll(MENTION_REGEX)) {
    const index = match.index ?? 0
    if (index > 0 && !MENTION_BOUNDARY.test(text[index - 1])) continue
    const quoted = match[1] !== undefined || match[2] !== undefined
    const raw = match[1] ?? match[2] ?? match[3]
    const mention = normalize(quoted ? raw.trim() : raw.replace(MENTION_TRIM, ""))
    if (mention && (mention === target || target.endsWith(`/${mention}`))) return true
  }
  return false
}

/**
 * The one text and image list OMP's `prompt` command takes.
 *
 * OMP has no synthetic message, so the context items ride in front of the
 * message as one authored text, separated by a blank line (the shape the
 * message-queue and scheduled-task ports already use). Every file must become
 * an image or an `@path` mention; one that can become neither fails the send
 * rather than being dropped from it.
 */
export const mapOmpPrompt = (
  text: string,
  context: ReadonlyArray<{ text: string; description?: string }> | undefined,
  files: ReadonlyArray<FileInputLite> | undefined,
): { text: string; images: OmpPromptImage[] } => {
  const blocks: string[] = []
  // A prompt that starts with `/name args` is expanded by OMP itself — file
  // commands, `/skill:<name>`, extension commands — so a command has to lead the
  // text: context in front of it would hide the slash and the command would go
  // out as literal text.
  const leads = text.trimStart().startsWith("/")
  if (leads && text.length > 0) blocks.push(text)
  for (const [index, item] of (context ?? []).entries()) {
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new Error(`OMP cannot send context item ${index + 1}: it carries no text`)
    }
    if (item.description?.trim()) blocks.push(item.description)
    blocks.push(item.text)
  }
  if (!leads && text.length > 0) blocks.push(text)
  let prompt = blocks.join("\n\n")

  const images: OmpPromptImage[] = []
  for (const file of files ?? []) {
    const dataUrl = BASE64_DATA_URL.exec(file.url)
    const mimeType = dataUrl?.[1].toLowerCase() ?? ""
    if (dataUrl && mimeType.startsWith("image/") && dataUrl[2].length > 0) {
      images.push({ type: "image", data: dataUrl[2], mimeType })
      continue
    }
    const path = dataUrl ? null : filePathFromUrl(file.url)
    if (!path) {
      throw new Error(
        `OMP cannot attach ${file.filename ? `"${file.filename}"` : "this file"}: an OMP prompt `
        + "carries images inline and every other file as an @path mention, and this attachment "
        + "has neither an image type nor a path",
      )
    }
    if (!isAlreadyMentioned(prompt, path)) {
      const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`
      prompt = prompt.length > 0 ? `${prompt} ${mention}` : mention
    }
  }

  return { text: prompt, images }
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const sessionRecordSchema = z.object({
  id: z.string().min(1),
  sessionPath: z.string(),
  cwd: z.string(),
  title: z.string(),
})

const sessionListSchema = z.object({ sessions: z.array(sessionRecordSchema) })
/** A created or forked session handle; `sessionFile` and `sessionPath` are the same file. */
const sessionHandleSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    sessionPath: z.string().nullable().optional(),
    sessionFile: z.string().nullable().optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
  }),
})
const okSchema = z.object({ ok: z.boolean() })
/** `GET /api/config/agents`: the agent files OMP discovers for a directory. */
const agentsListSchema = z.object({
  agents: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    mode: z.string().optional(),
    hidden: z.boolean().optional(),
    scope: z.string().optional(),
    path: z.string().optional(),
  })),
})
/** `set_thinking_level` answers with the level OMP applied. */
const thinkingLevelSchema = z.object({ level: z.string().min(1) })
const commandSchema = z.object({ name: z.string(), source: z.string(), description: z.string().optional() })
const commandsSchema = z.object({ commands: z.array(commandSchema) })
/** OMP's own context-usage numbers (`ContextUsage` in `pi-tui`); optional on the route. */
const contextUsageSchema = z.object({
  tokens: z.number(),
  contextWindow: z.number(),
  percent: z.number(),
})
/**
 * The session state route. `busy` is the host's own `isStreaming ||
 * isCompacting`; the rest is detail OMP reports alongside it. OMP has no error
 * state here: a failed turn is an event (`stopReason: "error"`), not a status.
 */
const statusSchema = z.object({
  busy: z.boolean(),
  compacting: z.boolean().optional(),
  queuedCount: z.number().optional(),
  tokensPerSecond: z.number().nullable().optional(),
  contextUsage: contextUsageSchema.nullable().optional(),
})
const permissionSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  message: z.string().optional(),
})
const permissionsSchema = z.object({ permissions: z.array(permissionSchema) })
// OMP's askable frames are projected to forms server-side; the field union is
// wide, so only the envelope is validated and the fields are trusted JSON from
// OpenChamber's own server, like the message projection above.
const formSchema = z.object({ id: z.string(), sessionID: z.string(), title: z.string() }).passthrough()
const formsSchema = z.object({ forms: z.array(formSchema) })
const mcpServersSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      scope: z.enum(["user", "project"]),
      enabled: z.boolean(),
      type: z.string(),
      command: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
})

const loginProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  available: z.boolean(),
  authenticated: z.boolean(),
})
const loginProvidersSchema = z.object({ providers: z.array(loginProviderSchema) })
const loginResultSchema = z.object({
  providerId: z.string().min(1),
  /**
   * Addresses the still-running flow's pending questions. OMP keeps the login
   * alive after answering with the browser URL, so a later manual-code prompt
   * is answered through the login id as if it were a session.
   */
  loginId: z.string().optional(),
  /** The browser URL OMP wants opened; absent when the flow completed inline. */
  url: z.string().optional(),
  launchUrl: z.string().optional(),
  instructions: z.string().optional(),
})

export type OmpLoginProvider = z.infer<typeof loginProviderSchema>
export type OmpLoginResult = z.infer<typeof loginResultSchema>

type OmpSessionRecord = z.infer<typeof sessionRecordSchema>

const toAgentSession = (record: OmpSessionRecord): AgentSession => ({
  id: record.id,
  runtimeId: "omp",
  nativeSessionId: record.id,
  projectID: "",
  directory: record.cwd,
  title: record.title,
  cost: 0,
  tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
  time: { created: 0, updated: 0 },
})

const unsupported = (operation: string): Promise<never> =>
  Promise.reject(new Error(`OMP runtime does not support ${operation}`))

const readJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) {
    // The route answers a refusal with `{ error }` naming the reason — a fork
    // cut with no branchable entry, say — and that reason is what the caller
    // reports; the status alone says nothing a user can act on.
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const reason = typeof body?.error === "string" ? body.error.trim() : ""
    throw new Error(reason.length > 0 ? reason : `OMP request failed: ${response.status}`)
  }
  return schema.parse(await response.json())
}

export class OmpRuntimeClient implements AgentRuntime {
  readonly id = "omp"
  readonly capabilities = CAPABILITIES

  private readonly basePath = "/api/agents/omp"

  constructor(private readonly fetchImpl: typeof runtimeFetch = runtimeFetch) {}

  async createSession(params?: CreateSessionParams, directory?: string | null): Promise<AgentSession> {
    void params
    const cwd = directory?.trim()
    const response = await this.fetchImpl(`${this.basePath}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cwd ? { cwd } : {}),
    })
    const parsed = await readJson(response, sessionHandleSchema)
    return toAgentSession({
      id: parsed.session.id,
      sessionPath: parsed.session.sessionPath ?? parsed.session.sessionFile ?? "",
      cwd: parsed.session.cwd ?? cwd ?? "",
      title: parsed.session.title ?? "",
    })
  }

  async getSession(id: string, directory?: string | null): Promise<AgentSession> {
    void directory
    const record = (await this.fetchSessions()).find((session) => session.id === id)
    if (!record) throw new Error(`unknown omp session: ${id}`)
    return toAgentSession(record)
  }

  async listSessions(directory?: string | null): Promise<AgentSession[]> {
    void directory
    return (await this.fetchSessions()).map(toAgentSession)
  }

  async listSessionsPage(options?: SessionListOptions): Promise<SessionPage> {
    void options
    return { sessions: await this.listSessions(), cursor: {} }
  }

  async getMessages(id: string, options?: { limit?: number; cursor?: string; order?: "asc" | "desc" }, directory?: string | null): Promise<MessagePage> {
    void options
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/messages`)
    if (!response.ok) {
      throw new Error(`OMP request failed: ${response.status}`)
    }
    // SAFETY: the server projects these items from the canonical Message/Part
    // model; the body is trusted JSON from OpenChamber's own server.
    return (await response.json()) as MessagePage
  }

  async sendPrompt(params: SendPromptParams): Promise<string> {
    // OMP cannot attach a skill by id, so the caller's instruction is the whole
    // delivery: it rides with the context items ahead of the message, in the
    // same position the command path puts it. Without this, an inline `/skill`
    // mention reached OMP as a bare token and the model never saw the skill.
    // `agentMentions` needs no equivalent: the mention is stripped from the text
    // upstream and OMP has no session agent to route to.
    const skillInstruction = params.skills?.names.length
      ? params.skills.instructionFor(params.skills.names)
      : null
    const context = skillInstruction
      ? [...(params.context ?? []), { text: skillInstruction }]
      : params.context
    const mapped = mapOmpPrompt(params.text, context, params.files)
    const body: OmpPromptBody = { text: mapped.text }
    if (params.messageId) body.messageId = params.messageId
    if (mapped.images.length > 0) body.images = mapped.images
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(params.id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    await readJson(response, okSchema)
    // OMP has no message id of its own; the id is the client's when it supplied
    // one, so the optimistic message reconciles in place.
    return params.messageId ?? ""
  }

  async cancel(id: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" })
    return (await readJson(response, okSchema)).ok
  }

  translateEvent(): RoutedAgentEvent[] {
    return []
  }

  async renameSession(id: string, title: string, directory?: string | null): Promise<void> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    await readJson(response, okSchema)
  }

  async deleteSession(id: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
    return (await readJson(response, okSchema)).ok
  }

  async moveSession(id: string, toDirectory: string, options?: MoveSessionOptions): Promise<void> {
    void options
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: toDirectory }),
    })
    await readJson(response, okSchema)
  }

  async listCommands(directory?: string | null, signal?: AbortSignal): Promise<Command[]> {
    void directory
    void signal
    const response = await this.fetchImpl(`${this.basePath}/commands`)
    return (await readJson(response, commandsSchema)).commands.map((command) => ({
      name: command.name,
      description: command.description,
    }))
  }

  async listSkills(directory?: string | null): Promise<Skill[]> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/commands`)
    return (await readJson(response, commandsSchema)).commands
      .filter((command) => command.source === "skill")
      .map((command) => ({
        id: command.name,
        name: command.name,
        description: command.description,
        path: "",
        content: "",
      }))
  }

  // --- Provider login. Not part of the `AgentRuntime` contract (it is not a
  // session operation), so the providers page reaches it on this class directly.

  /** The OAuth providers OMP can log in to, with their current auth status. */
  async listLoginProviders(): Promise<OmpLoginProvider[]> {
    const response = await this.fetchImpl(`${this.basePath}/login/providers`)
    return (await readJson(response, loginProvidersSchema)).providers
  }

  /**
   * Starts a login. Resolves as soon as OMP has something for the user: the
   * `url` to open, or a completed flow carrying only `providerId`. The flow
   * keeps running server-side; `loginId` addresses a later manual-code prompt,
   * and `listLoginProviders()` reports when the provider is authenticated.
   */
  async login(providerId: string): Promise<OmpLoginResult> {
    const response = await this.fetchImpl(`${this.basePath}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId }),
    })
    return readJson(response, loginResultSchema)
  }

  async getActiveStatus(directory?: string | null): Promise<Record<string, SessionStatus> | null> {
    try {
      const sessions = await this.fetchSessions()
      const scoped = directory ? sessions.filter((session) => session.cwd === directory) : sessions
      const entries = await Promise.all(
        scoped.map(async (session) => {
          const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(session.id)}/status`)
          const status = await readJson(response, statusSchema)
          // `busy` already folds in a compaction running without a stream, so
          // the local "is this session active" readers keep working; the rest
          // rides along for consumers that want the detail.
          const state: SessionStatus = status.busy ? { type: "busy" } : { type: "idle" }
          if (status.compacting !== undefined) state.compacting = status.compacting
          if (status.queuedCount !== undefined) state.queuedCount = status.queuedCount
          if (status.tokensPerSecond !== undefined) state.tokensPerSecond = status.tokensPerSecond
          if (status.contextUsage !== undefined) state.contextUsage = status.contextUsage
          return [session.id, state] as const
        }),
      )
      return Object.fromEntries(entries)
    } catch {
      // A failed snapshot is `null`, never an empty authoritative result.
      return null
    }
  }

  async replyPermission(sessionID: string, requestID: string, reply: PermissionReply, options?: { message?: string; directory?: string | null }): Promise<boolean> {
    void options
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    })
    return (await readJson(response, okSchema)).ok
  }

  async getPermission(sessionID: string, requestID: string, directory?: string | null): Promise<FetchPermissionResult> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionID)}/permissions`)
    const permission = (await readJson(response, permissionsSchema)).permissions.find((entry) => entry.id === requestID)
    return permission ? { state: "ok", permission } : { state: "unknown" }
  }

  async listPermissions(options?: PendingRequestListOptions): Promise<PermissionRequest[]> {
    const sessions = await this.fetchSessions()
    const directories = options?.directories?.filter((value): value is string => Boolean(value))
    const scoped = directories && directories.length > 0
      ? sessions.filter((session) => directories.includes(session.cwd))
      : sessions
    const lists = await Promise.all(
      scoped.map(async (session) => {
        const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(session.id)}/permissions`)
        return (await readJson(response, permissionsSchema)).permissions
      }),
    )
    return lists.flat()
  }

  async listMcpServers(directory?: string | null): Promise<McpServerStatus[]> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const response = await this.fetchImpl(`${this.basePath}/mcp${query}`)
    return (await readJson(response, mcpServersSchema)).servers.map((server) => ({
      name: server.name,
      status: { status: server.enabled ? ("connected" as const) : ("disabled" as const) },
    }))
  }

  async connectMcpServer(server: string, directory?: string | null): Promise<void> {
    void directory
    await this.setMcpEnabled(server, true)
  }

  async disconnectMcpServer(server: string, directory?: string | null): Promise<void> {
    void directory
    await this.setMcpEnabled(server, false)
  }

  private async setMcpEnabled(server: string, enabled: boolean): Promise<void> {
    const response = await this.fetchImpl(`${this.basePath}/mcp/${encodeURIComponent(server)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
    await readJson(response, okSchema)
  }

  async selectModel(id: string, model: ModelRef, directory?: string | null): Promise<void> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: model.providerID, modelId: model.id }),
    })
    await readJson(response, okSchema)
  }

  /**
   * Sets the session's thinking effort. OMP validates the level against its own
   * `ThinkingLevel` enum and the server rejects anything else with a 400 naming
   * the accepted values, so a level the picker offers always round-trips.
   */
  async setThinkingLevel(id: string, level: string, directory?: string | null): Promise<string> {
    void directory
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(id)}/thinking`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    })
    return (await readJson(response, thinkingLevelSchema)).level
  }

  private async fetchSessions(): Promise<OmpSessionRecord[]> {
    const response = await this.fetchImpl(`${this.basePath}/sessions`)
    return (await readJson(response, sessionListSchema)).sessions
  }

  // --- Unsupported: the capability above is `false`, so no caller reaches these.
  // The parameters are omitted (a narrower signature still satisfies the
  // contract), so an implemented method is the only place that reads them.

  /**
   * The agent markdown files OMP discovers (`<agent dir>/agents`, project
   * `.omp/agents`), which the server lists from the same files the config
   * routes edit. This is the catalog the Agents page and the composer's
   * defaults read; OMP chooses a subagent inside the model's own `task` call,
   * so `agentSelection` stays false and no session agent is picked from it.
   */
  async listAgents(directory?: string | null): Promise<Agent[]> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const response = await this.fetchImpl(`/api/config/agents${query}`)
    const listed = await readJson(response, agentsListSchema)
    return listed.agents.map((agent) => ({
      id: agent.name,
      name: agent.name,
      displayName: agent.name,
      description: agent.description,
      // OMP's files may name no mode: "all" is the vocabulary's neutral value.
      mode: agent.mode ?? "all",
      hidden: agent.hidden === true,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
    }))
  }

  stageRevert(): Promise<SessionRevert> {
    return unsupported("stageRevert")
  }

  commitRevert(): Promise<void> {
    return unsupported("commitRevert")
  }

  clearRevert(): Promise<void> {
    return unsupported("clearRevert")
  }

  getSessionTurnDiff(): Promise<FileDiffInfo[]> {
    return unsupported("getSessionTurnDiff")
  }

  // --- Fork: `branch { entryId }` copies the transcript up to an entry.

  async forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<AgentSession> {
    const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(sessionId)}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `before` is the transcript cut the fork copies through; OMP names it
      // `entryId`. OMP branches *before* a user message, so there is no
      // whole-transcript fork: omitting the cut is not "copy everything", it is
      // a request the route refuses with a reason the caller reports. A cut the
      // session cannot branch at is refused the same way, leaving the original
      // session untouched.
      body: JSON.stringify(options?.before ? { entryId: options.before } : {}),
    })
    const parsed = await readJson(response, sessionHandleSchema)
    return toAgentSession({
      id: parsed.session.id,
      sessionPath: parsed.session.sessionPath ?? parsed.session.sessionFile ?? "",
      cwd: parsed.session.cwd ?? options?.directory ?? "",
      title: parsed.session.title ?? "",
    })
  }

  // --- Forms: OMP's `ask` tool asks through `extension_ui_request` frames the
  // server projects as forms. A reply carries every answer at once; a cancel
  // tells OMP the question was dismissed so the turn does not stall.

  async listPendingForms(options?: PendingRequestListOptions): Promise<FormInfo[]> {
    const sessions = await this.fetchSessions()
    const directories = options?.directories?.filter((value): value is string => Boolean(value))
    const scoped = directories && directories.length > 0
      ? sessions.filter((session) => directories.includes(session.cwd))
      : sessions
    const lists = await Promise.all(
      scoped.map(async (session) => {
        const response = await this.fetchImpl(`${this.basePath}/sessions/${encodeURIComponent(session.id)}/forms`)
        // SAFETY: the server projects these from OMP's askable frames; the body
        // is trusted JSON from OpenChamber's own server.
        return (await readJson(response, formsSchema)).forms as unknown as FormInfo[]
      }),
    )
    return lists.flat()
  }

  async replyForm(sessionID: string, formID: string, answer: FormAnswer, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(
      `${this.basePath}/sessions/${encodeURIComponent(sessionID)}/forms/${encodeURIComponent(formID)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The whole answer record travels in one body: a question left out of
        // it would leave the `ask` tool waiting.
        body: JSON.stringify({ answer }),
      },
    )
    if (!response.ok) throw new Error(`OMP request failed: ${response.status}`)
    return true
  }

  async cancelForm(sessionID: string, formID: string, directory?: string | null): Promise<boolean> {
    void directory
    const response = await this.fetchImpl(
      `${this.basePath}/sessions/${encodeURIComponent(sessionID)}/forms/${encodeURIComponent(formID)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancelled: true }),
      },
    )
    if (!response.ok) throw new Error(`OMP request failed: ${response.status}`)
    return true
  }

  // --- Slash commands: OMP expands `/name args` inside `prompt` (file
  // commands, `/skill:<name>`, extension commands, MCP prompts), so a command
  // is sent as prompt text through the same attachment folding as a prompt.

  async sendCommand(params: SendCommandParams): Promise<void> {
    const text = params.arguments?.trim() ? `/${params.command} ${params.arguments.trim()}` : `/${params.command}`
    await this.sendPrompt({
      runtimeKey: params.runtimeKey,
      id: params.id,
      // Unused by the OMP prompt path; the contract requires the field.
      providerID: "",
      model: params.model,
      agent: params.agent,
      text,
      files: params.files,
      context: params.context,
      delivery: params.delivery,
      directory: params.directory,
    })
  }
}