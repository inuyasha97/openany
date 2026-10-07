/**
 * Runtime error surface.
 *
 * Whatever an agent-runtime request threw — a tagged body, a dropped HTTP
 * status, a plain transport failure — is normalised into `OpencodeApiError`
 * here, so callers can branch on `status` / `tag` without knowing which layer
 * threw.
 */

import { z } from "zod"
import { isAmbiguousTransportFailure, markAmbiguousTransportFailure } from "@/lib/relay/transport-error"

/**
 * HTTP status for the tagged error bodies the runtime returns. The generated
 * client throws the parsed body for declared statuses and drops the status,
 * so callers that branch on 404 / 401 need it restored from the tag.
 */
const STATUS_BY_TAG: Record<string, number | undefined> = {
  InvalidRequestError: 400,
  InvalidCursorError: 400,
  FormInvalidAnswerError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  SessionNotFoundError: 404,
  MessageNotFoundError: 404,
  PermissionNotFoundError: 404,
  FormNotFoundError: 404,
  AgentNotFoundError: 404,
  CommandNotFoundError: 404,
  SkillNotFoundError: 404,
  ProviderNotFoundError: 404,
  McpServerNotFoundError: 404,
  ProjectNotFoundError: 404,
  FileNotFoundError: 404,
  PtyNotFoundError: 404,
  ShellNotFoundError: 404,
  ConflictError: 409,
  SessionBusyError: 409,
  FormAlreadySettledError: 409,
  ServiceUnavailableError: 503,
  UnknownError: 500,
}

export class OpencodeApiError extends Error {
  readonly operation: string
  readonly status: number | undefined
  /** The error class the runtime named in a tagged body (`SessionNotFoundError`, `UnknownError`, ...). */
  readonly tag: string | undefined
  /** What the body said, without the operation prefix `message` carries. */
  readonly detail: string
  /** The id the runtime prints next to the stack in its own log for a 500, so a
      surface can quote something that can be searched for. */
  readonly ref: string | undefined

  constructor(operation: string, message: string, options: { status?: number; tag?: string; ref?: string; cause?: unknown }) {
    super(`${operation} failed${options.status ? ` (${options.status})` : ""}: ${message}`, { cause: options.cause })
    this.name = "OpencodeApiError"
    this.operation = operation
    this.status = options.status
    this.tag = options.tag
    this.detail = message
    this.ref = options.ref
  }
}

const taggedErrorSchema = z.object({ _tag: z.string(), message: z.string().optional(), ref: z.string().optional() })

/**
 * Turns whatever the runtime threw into an `OpencodeApiError` with a status
 * the rest of the app can branch on. Transport failures keep their relay
 * "outcome unknown" marker so a lost response is not mistaken for a request
 * that never left.
 */
export function normalizeOpencodeError(operation: string, error: unknown): OpencodeApiError {
  if (error instanceof OpencodeApiError) return error
  const tagged = taggedErrorSchema.safeParse(error)
  if (tagged.success) {
    return new OpencodeApiError(operation, tagged.data.message ?? tagged.data._tag, {
      status: STATUS_BY_TAG[tagged.data._tag],
      tag: tagged.data._tag,
      ref: tagged.data.ref,
      cause: error,
    })
  }
  if (error instanceof Error) {
    const wrapped = new OpencodeApiError(operation, error.message, { cause: error })
    if (isAmbiguousTransportFailure(error)) markAmbiguousTransportFailure(wrapped)
    return wrapped
  }
  return new OpencodeApiError(operation, String(error), { cause: error })
}

export const isOpencodeNotFound = (error: unknown): boolean =>
  error instanceof OpencodeApiError && error.status === 404
