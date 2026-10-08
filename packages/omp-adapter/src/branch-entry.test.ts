import { describe, expect, test } from "bun:test"
import { BRANCH_CUT_REQUIRED, resolveBranchEntry, type OmpBranchEntry } from "./branch-entry"
import type { OmpSessionMessageEntry } from "./session-store"

// A two-turn transcript, in file order, and the user entries OMP accepts.
const ENTRIES: OmpSessionMessageEntry[] = [
  { id: "aaaa0001", role: "user", timestamp: 1000 },
  { id: "aaaa0002", role: "assistant", timestamp: 2000 },
  { id: "aaaa0003", role: "user", timestamp: 3000 },
  { id: "aaaa0004", role: "assistant", timestamp: 4000 },
]
const BRANCHABLE: OmpBranchEntry[] = [
  { entryId: "aaaa0001", text: "first" },
  { entryId: "aaaa0003", text: "second" },
]

/** Runs `resolveBranchEntry` and returns the refusal it throws. */
const refusalOf = (cut: string, branchable: OmpBranchEntry[] = BRANCHABLE): Error => {
  try {
    resolveBranchEntry(cut, ENTRIES, branchable)
  } catch (error) {
    return error as Error
  }
  throw new Error(`expected resolveBranchEntry(${cut}) to refuse`)
}

describe("resolveBranchEntry", () => {
  test("maps a projected user message id onto its session-file entry", () => {
    expect(resolveBranchEntry("omp:ses_1:user:1000", ENTRIES, BRANCHABLE)).toBe("aaaa0001")
    expect(resolveBranchEntry("omp:ses_1:user:3000", ENTRIES, BRANCHABLE)).toBe("aaaa0003")
  })

  test("passes a real entry id straight through", () => {
    expect(resolveBranchEntry("aaaa0003", ENTRIES, BRANCHABLE)).toBe("aaaa0003")
  })

  test("branches at the next user entry when the cut lands on a reply", () => {
    // "fork after this answer": the cut is the reply, OMP branches before the
    // user message that follows it.
    expect(resolveBranchEntry("omp:ses_1:assistant:2000", ENTRIES, BRANCHABLE)).toBe("aaaa0003")
  })

  test("branches at the next user entry when the cut names a non-branchable entry", () => {
    expect(resolveBranchEntry("aaaa0002", ENTRIES, BRANCHABLE)).toBe("aaaa0003")
  })

  test("refuses a cut past the last user message with the whole-transcript reason", () => {
    // The last reply is the last entry, so there is no user entry at or after
    // it: OMP cannot copy the whole transcript.
    expect(refusalOf("omp:ses_1:assistant:4000").message).toBe(BRANCH_CUT_REQUIRED)
  })

  test("refuses a cut that names no message in the session, naming it", () => {
    for (const cut of ["omp:ses_1:user:9999", "msg_client_1", "not-an-entry"]) {
      const error = refusalOf(cut)
      expect(error.name).toBe("OmpBranchCutError")
      expect(error.message.includes(cut)).toBe(true)
    }
  })

  test("refuses when the session has no branchable user message at all", () => {
    expect(refusalOf("omp:ses_1:user:1000", []).message).toBe(BRANCH_CUT_REQUIRED)
  })

  test("refuses an empty cut with the same whole-transcript reason", () => {
    expect(refusalOf("").message).toBe(BRANCH_CUT_REQUIRED)
    expect(refusalOf("   ").message).toBe(BRANCH_CUT_REQUIRED)
  })
})
