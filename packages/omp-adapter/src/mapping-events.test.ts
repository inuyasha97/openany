import { describe, expect, test } from "bun:test"
import { toSyncEvents } from "./mapping-events"

describe("toSyncEvents", () => {
  test("agent_start marks the session busy", () => {
    expect(toSyncEvents("ses_a", { type: "agent_start" })).toEqual([
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    ])
  })

  test("agent_end marks the session idle", () => {
    expect(toSyncEvents("ses_a", { type: "agent_end" })).toEqual([
      { type: "session.idle", properties: { sessionID: "ses_a" } },
    ])
  })

  test("an unmapped event yields nothing", () => {
    expect(toSyncEvents("ses_a", { type: "turn_start" })).toEqual([])
  })
})
