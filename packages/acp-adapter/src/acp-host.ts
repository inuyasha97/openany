/**
 * The real ACP host: the JSON-RPC client behind `AcpRuntime`.
 *
 * One agent process per session. The transport is injected so the client is
 * testable without a process; `process-transport.ts` is the stdio transport.
 *
 * ACP is bidirectional. The agent streams `session/update` notifications and
 * sends its own requests back: `session/request_permission` is answered by the
 * user (`replyPermission`), everything else — the optional `fs/*` and
 * `terminal/*` surface — is refused with method-not-found, because OpenChamber
 * does not delegate file or terminal access in this milestone.
 *
 * ACP v1 has no session-list method and no required `session/load`, so
 * `listSessions` is empty and a session exists only while its process does;
 * reopening one after a restart is a later milestone.
 *
 * Every inbound line is parsed with a schema at this boundary, so the client
 * branches on domain values rather than on `typeof`.
 */

import { z } from "zod"
import type { JsonValue } from "@openchamber/ui/lib/opencode/model"
import type { AcpEvent, AcpPermissionOption } from "./model"
import type { AcpHost, AcpPermissionReply, AcpSessionHandle, AcpSessionInfo } from "./runtime"

export type AcpTransport = {
  write: (line: string) => void
  onLine: (listener: (line: string) => void) => () => void
  close: () => void
}

export type CreateAcpHostOptions = {
  /** One transport per session process. */
  createTransport: () => AcpTransport
}

const ACP_PROTOCOL_VERSION = 1
const METHOD_NOT_FOUND = -32601

const contentBlockSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough()
const contentSchema = z.union([contentBlockSchema, z.array(contentBlockSchema)]).optional()

const updateSchema = z.object({
  sessionUpdate: z.string(),
  content: contentSchema,
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
}).passthrough()

const paramsSchema = z.object({
  sessionId: z.string().optional(),
  update: updateSchema.optional(),
  toolCall: z.object({ toolCallId: z.string().optional() }).passthrough().optional(),
  options: z.array(z.object({ optionId: z.string(), kind: z.string().optional(), name: z.string().optional() }).passthrough()).optional(),
}).passthrough()

const envelopeSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: paramsSchema.optional(),
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

const sessionNewResultSchema = z.object({ sessionId: z.string().min(1) })
const promptResultSchema = z.object({ stopReason: z.string().optional() }).passthrough()

type AcpUpdate = z.infer<typeof updateSchema>

/** ACP content includes text blocks; join them, ignore the rest. */
const textOfContent = (content: z.infer<typeof contentSchema>): string => {
  if (!content) return ""
  const blocks = Array.isArray(content) ? content : [content]
  let text = ""
  for (const block of blocks) {
    if (block.type === "text" && block.text) text += block.text
  }
  return text
}

const normalizeUpdate = (update: AcpUpdate): AcpEvent | undefined => {
  if (update.sessionUpdate === "agent_message_chunk") return { type: "message_delta", role: "assistant", text: textOfContent(update.content) }
  if (update.sessionUpdate === "user_message_chunk") return { type: "message_delta", role: "user", text: textOfContent(update.content) }
  if (update.sessionUpdate === "agent_thought_chunk") return { type: "message_delta", role: "thought", text: textOfContent(update.content) }
  if (update.sessionUpdate === "tool_call") {
    return update.toolCallId ? { type: "tool_call", toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status } : undefined
  }
  if (update.sessionUpdate === "tool_call_update") {
    return update.toolCallId ? { type: "tool_call_update", toolCallId: update.toolCallId, status: update.status, text: textOfContent(update.content) || undefined } : undefined
  }
  // `plan`, mode changes, command lists and anything new: no canonical event yet.
  return undefined
}

export const createAcpHost = ({ createTransport }: CreateAcpHostOptions): AcpHost => {
  const openSession = async (input: { sessionId?: string; cwd?: string }): Promise<AcpSessionHandle> => {
    if (input.sessionId) {
      // No `session/load`: a session exists only in the process that created it.
      throw new Error(`unknown acp session: ${input.sessionId}`)
    }

    const transport = createTransport()
    const listeners = new Set<(event: AcpEvent) => void>()
    const pending = new Map<string, { resolve: (result: JsonValue | undefined) => void; reject: (error: Error) => void }>()
    const permissionIds = new Set<string>()
    let nextId = 1
    let sessionId = ""

    const emit = (event: AcpEvent) => {
      for (const listener of listeners) listener(event)
    }

    const respondError = (id: string | number | undefined, code: number, message: string) => {
      transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
    }

    const onMessage = (message: z.infer<typeof envelopeSchema>) => {
      if (message.method === "session/update") {
        const update = message.params?.update
        if (!update) return
        const event = normalizeUpdate(update)
        if (event) emit(event)
        return
      }
      if (message.method === "session/request_permission") {
        const requestId = String(message.id)
        permissionIds.add(requestId)
        const options: AcpPermissionOption[] = (message.params?.options ?? []).map((option) => ({ optionId: option.optionId, kind: option.kind ?? "", name: option.name }))
        emit({ type: "permission_request", requestId, toolCallId: message.params?.toolCall?.toolCallId, options })
        return
      }
      if (message.method !== undefined) {
        // An agent request we do not implement: `fs/*`, `terminal/*`, extensions.
        respondError(message.id, METHOD_NOT_FOUND, `Unsupported client method: ${message.method}`)
        return
      }
      if (message.id === undefined) return
      const waiting = pending.get(String(message.id))
      if (!waiting) return
      pending.delete(String(message.id))
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    }

    const unsubscribeLines = transport.onLine((line) => {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return
      }
      const parsed = envelopeSchema.safeParse(raw)
      if (!parsed.success) return
      onMessage(parsed.data)
    })

    const request = (method: string, params: JsonValue): Promise<JsonValue | undefined> =>
      new Promise((resolve, reject) => {
        const id = nextId
        nextId += 1
        pending.set(String(id), { resolve, reject })
        transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })

    try {
      await request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const created = sessionNewResultSchema.safeParse(await request("session/new", { cwd: input.cwd ?? "", mcpServers: [] }))
      if (!created.success) throw new Error("acp session/new returned no session id")
      sessionId = created.data.sessionId
    } catch (error) {
      unsubscribeLines()
      transport.close()
      throw error
    }

    const handle: AcpSessionHandle = {
      id: sessionId,
      prompt: async (text) => {
        const result = promptResultSchema.safeParse(await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }))
        emit({ type: "turn_ended", stopReason: result.success ? result.data.stopReason : undefined })
        return true
      },
      cancel: async () => {
        transport.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }))
      },
      replyPermission: async ({ requestId, optionId }: AcpPermissionReply) => {
        if (!permissionIds.has(requestId)) return false
        permissionIds.delete(requestId)
        const outcome = optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId }
        transport.write(JSON.stringify({ jsonrpc: "2.0", id: Number(requestId), result: { outcome } }))
        return true
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      dispose: async () => {
        unsubscribeLines()
        transport.close()
      },
    }

    return handle
  }

  return {
    listSessions: async (): Promise<AcpSessionInfo[]> => [],
    openSession,
  }
}
