/**
 * The ACP shapes the adapter consumes.
 *
 * A normalized session event, not the raw ACP notification: `acp-host.ts`
 * unpacks JSON-RPC `session/update` notifications into this shape, and the
 * server-side mapping narrows it into `SyncEvent`. It stays a stub until the
 * mapping milestone needs fields.
 */

export type AcpEvent = { type: string }
