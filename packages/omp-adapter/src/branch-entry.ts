/**
 * Resolving an OpenChamber transcript cut onto an OMP session entry.
 *
 * The UI names a fork cut with a canonical `Message.id`, never an OMP entry id:
 * a projected message id is `omp:<sessionId>:<role>:<timestamp>` (`ompMessageId`)
 * and an optimistic message keeps the client's own id. OMP's `branch` resolves a
 * session-file entry id against its own tree and refuses anything that is not a
 * user-message entry (`AgentSession.branch` -> `getEntry`), so the cut has to be
 * translated before the RPC.
 *
 * The translation is positional and uses two facts:
 *
 * - A projected id carries the message timestamp, which the session file
 *   records next to the entry id (`parseSessionMessageEntries`).
 * - OMP's `get_branch_messages` names the user-message entries it will accept,
 *   in transcript order.
 *
 * `branch` copies everything *before* the named entry, so a cut resolves to the
 * first branchable user entry at or after it: a cut that lands on a user
 * message branches there, and one that lands on an assistant message, a
 * compaction or a synthetic carrier branches at the next user message it
 * precedes. A cut past the last user message names nothing OMP can branch at —
 * it cannot copy a whole transcript — and is refused rather than silently
 * turned into an empty session.
 */

import { parseOmpMessageId } from "./mapping-messages"
import type { OmpSessionMessageEntry } from "./session-store"

/** One user message OMP will branch at (`get_branch_messages`). */
export type OmpBranchEntry = { entryId: string; text: string }

/**
 * The one refusal a cut that names no branchable user entry produces. OMP
 * branches *before* a user message, so it has no way to express "copy
 * everything": the cut has to be a user message the session still has. The
 * route returns the same text when the request names no cut at all.
 */
export const BRANCH_CUT_REQUIRED =
  "Cannot fork here: OMP branches before a user message and cannot copy a whole transcript. Choose the user message to branch at."

/** The cut names nothing in the session, so OMP has no entry to resolve. */
export class OmpBranchCutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OmpBranchCutError"
  }
}

/** The index of the entry a projected or entry id names, or -1 when it names none. */
const locateCut = (cut: string, entries: readonly OmpSessionMessageEntry[]): number => {
  const projected = parseOmpMessageId(cut)
  if (projected) {
    // The timestamp identifies the message; the role disambiguates the rare
    // collision (a user and an assistant entry sharing a stamp), and a
    // synthetic carrier has no entry of its own so its stamp alone places it.
    let fallback = -1
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry.timestamp !== projected.timestamp) continue
      if (entry.role === projected.role) return index
      if (fallback < 0) fallback = index
    }
    return fallback
  }
  // A real entry id that is not branchable (an assistant message, a marker)
  // still places the cut, so the walk can find the user entry after it.
  return entries.findIndex((entry) => entry.id === cut)
}

/**
 * The OMP entry id `cut` branches at.
 *
 * @param cut the UI's canonical `Message.id`
 * @param entries the session file's message entries, in order
 * @param branchable the user entries OMP accepts (`get_branch_messages`)
 */
export const resolveBranchEntry = (
  cut: string,
  entries: readonly OmpSessionMessageEntry[],
  branchable: readonly OmpBranchEntry[],
): string => {
  if (cut.trim().length === 0) throw new OmpBranchCutError(BRANCH_CUT_REQUIRED)

  const ids = new Set(branchable.map((entry) => entry.entryId))
  if (ids.has(cut)) return cut

  const at = locateCut(cut, entries)
  if (at < 0) {
    throw new OmpBranchCutError(
      `No message in this session matches the branch cut "${cut}"; OMP branches before a user message, `
      + "so the cut must name a message the session still has.",
    )
  }
  for (let index = at; index < entries.length; index += 1) {
    if (ids.has(entries[index].id)) return entries[index].id
  }
  throw new OmpBranchCutError(BRANCH_CUT_REQUIRED)
}
