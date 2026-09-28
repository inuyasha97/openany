import type { SyncEvent } from "@openchamber/ui/lib/agent/events"
import type { OmpEvent } from "./runtime"

/**
 * Maps a raw OMP session event onto the canonical vocabulary.
 *
 * The run boundaries land first: they drive the session status. Text, tool and
 * message events need the OMP message projection and follow. An event with no
 * mapping returns an empty list.
 *
 * OMP events carry no session id; the caller supplies the session the event
 * came from.
 */
export const toSyncEvents = (sessionId: string, event: OmpEvent): SyncEvent[] => {
  switch (event.type) {
    case "agent_start":
      return [{ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }]
    case "agent_end":
      return [{ type: "session.idle", properties: { sessionID: sessionId } }]
    default:
      return []
  }
}
