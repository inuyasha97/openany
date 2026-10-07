# Session assist

The server generates a short reminder of recent work and an optional next user
message with Small Model. Results live in `metadata.openchamber.assist` with
`recap`, `suggestion`, `forMessageID`, and `generatedAt`. The payload shape is
unchanged; an empty suggestion is a successful outcome.

## Ownership

- `runtime.js` owns idle timers, cancellation, provider selection, runtime-host
  reads, freshness checks, settings gates, and metadata writes.
- `context.js` reads history and constructs human turns. It removes tool
  payloads and injected prompts before retaining message text.
- `prompt.js` owns the generation instructions and total input budget.
- `../small-model/DOCUMENTATION.md` owns provider/auth resolution, generation,
  output limits, and overflow behavior.

## What the model receives

Read the session's history oldest first through the OMP runtime host
(`../agents/omp-host-access.js`). The host serves a session's whole history in
one page, so a single read covers every turn the Small Model can need. A failed
read aborts generation; it is not treated as complete history. If the latest
answer's human request has not been found, skip generation rather than invent
its context.

Three turns retain the substance behind short commit confirmations without
bringing an entire old task back into the prompt. This was compared against
one, five, ten, and full-history contexts on long maintainer sessions. There
is no full-history cache and no assumed provider prefix-cache behavior.

The latest content record must be a completed, successful, non-summary
assistant answer with visible text. Records that carry no conversation content
— the agent/model/location switches and an `idle` marker whose outcome is
`succeeded` — are skipped by `newestContentId`, both here and in the re-check
before the write. The OMP host keeps no such records in a history read, so the
newest content record is normally the last one; the guard keeps a reader that
does report them correct. An `idle` whose outcome is `failed` or `interrupted`
is not skipped: it disqualifies the turn. Sessions the runtime no longer lists,
and archived sessions, are skipped. OMP has no parent and no revert boundary, so
there is no child or reverted session to exclude here.

Human turns follow chronological message intervals: a turn is one user message
and the assistant reply that follows it. Compaction summaries are excluded. An
interrupted request remains context with its last visible progress explicitly
labeled as unfinished, rather than being dropped or called a final answer. The
final answer must close the newest user turn; a late answer to an older request
is not accepted.

### Attached context and language

The persisted attachment contract is owned by
`packages/ui/src/lib/messages/contextParts.ts`. Its user-facing Markdown
formatter is `packages/ui/src/lib/messages/messageMarkdown.ts`.

The server projects those persisted parts into model context without importing
the UI runtime: code comments, file/chat quotes, browser annotations, PR comments,
checks, terminal selections, and linked GitHub/Linear items remain attached to
the user turn even when their transport record is a `synthetic` one. The
`opencodeComment` mirror is also accepted. Unrecognized synthetic prompts and
ignored parts are excluded. Malformed attached text fails the generation.

Quoted material and the user's own comment are separate blocks. The user's
authored text is also supplied separately for language selection. Quoted source,
logs, assistant replies, and injected memory instructions do not choose the
language. A language-neutral final acknowledgment can use recent authored text.
The existing Cyrillic/CJK mismatch guard uses that authored sample per field;
it is not a complete language detector, and it is skipped if no sample exists.

### Input bounds

User text is bounded to 8,000 characters and each assistant answer to 16,000.
Attached quote bodies have their own 4,000-character limit so a large quote
does not consume the user's comment. Excerpts preserve both ends with an
explicit omission marker, including the conclusion of a long final report.

The complete user prompt is limited to 32,000 characters and the resolved small
model's input allowance, reserving space for the system prompt. Under pressure,
drop older whole turns first. If the latest pair itself is too large, excerpt
both its user request and answer rather than discarding either side. If even
the minimum prompt cannot fit, skip generation. `onOverflow: 'error'` prevents
the Small Model service from silently cutting off the instructions. Expected
context/output-budget failures are quiet and do not write metadata.

A history read still carries complete tool payloads even though the retained
model context is small. A single long turn can therefore require substantial
I/O. The read is not a network-byte quota.

## Generation and lifecycle

1. The server's existing global event fan-out calls `processPayload`. At an
   idle event the runtime first asks the injected `evaluateTurn` (the
   session-work runtime, `../session-work/DOCUMENTATION.md`): one Jev call says
   which enabled fields are worth the Small Model. It then arms the 60-second
   quiet window for those fields only, and arms nothing when Jev ruled both out.
   An unknown answer (no Jev, a failure) keeps every enabled field, so without
   Jev nothing changes. A newer event drops a pending answer. A session that
   `../session-lineage.js` knows to be a subsession arms nothing at all: no
   gate, no timer, no read. No history scan or
   startup backfill runs.
2. Busy/retry events and newly created user messages clear pending work and
   abort in-flight generation. The host history read itself is not
   interruptible; the run checks its abort signal between steps. Re-emitted old
   user updates do not cancel it.
3. One generation runs per session. If a newer quiet window expires while an
   old canceled request is still settling, retain that pending run and start it
   after the old one finishes. Later activity cancels the pending run as well.
4. Resolve the small model using the last answer's provider/model and the
   existing explicit settings/config overrides. `restrictToPreferredProvider`
   prevents an implicit cross-provider fallback. Production does not pin the
   experimental model. Generation accepts an abort signal and a 120-second limit.
5. Recap describes the substantive work and its current result, including the
   work behind a closing commit or acknowledgment. Suggestion is independent:
   only unfinished requested agent work should produce a sendable user message.
   Completed work, optional offers, or a decision/action belonging to the user
   should return an empty suggestion. This is model judgment, not authorization
   enforcement or a guarantee that every generated field is factually correct.
6. Re-read the history and the session list before writing. A moved tail,
   canceled run, session that disappeared or changed its directory, archive, or
   failed fresh read discards the result. Never merge from the old
   pre-generation metadata.
7. Re-check settings, clamp the enabled fields, and merge into fresh metadata.
   The session metadata write has no compare-and-set operation; another
   writer after the final read is not guarded atomically.

Stopping the runtime clears pending timers/runs and aborts in-flight operations.
No failed session blocks another session.

## Settings and consumers

`sessionRecapEnabled` and `sessionSuggestionEnabled` default on and are checked
before work and before writing. The Jev gate is a cost filter under these same
switches, not a setting of its own: it reads the same three turns as the recap,
so a recap still follows a closing "thanks" after real work. With both off there are no reads, model calls,
or writes. With one on, the shared recent context is still available, but only
that field is requested. An empty suggestion does not erase a valid recap.

Freshness has one rule, `getCurrentSessionAssist` in
`packages/ui/src/lib/sessionAssistMetadata.ts`, computed from the session
record alone so the chat and the sidebar row always agree: the payload is
current while `generatedAt >= session.time.idle` and the session is not
reverted. The runtime moves `time.idle` at every turn end, succeeded or failed.
Do not compare `forMessageID` with the last loaded message: the newest record
can be a service record or an `idle` marker, never the answer itself.
When a session turns busy, the runtime also deletes the assist it wrote
(`persistSessionAssist(id, dir, null)`), so stored state goes stale only for
payloads written by an earlier process; the `time.idle` rule retires those.

- `packages/ui/src/lib/sessionAssistMetadata.ts` parses the payload and owns freshness.
- `packages/ui/src/hooks/useSessionAssist.ts` adds live-status and settings gating.
- `SessionRecapSpacer` shows the reminder in the reserved gap under the reply.
- `SessionSuggestionChip` fills the composer; it never sends automatically.
- Sidebar rows (`SessionNodeItem`, Projects view) show the current recap in
  the whole-row tooltip under the same freshness rule, hidden while a turn runs
  and when `sessionRecapEnabled` is off. The sidebar no longer marks open
  suggestions; the "In work" block is the sidebar's attention signal.

Web, Electron, hosted mobile, and Capacitor use the server watcher. VS Code's
extension-only runtime does not generate assists; shared UI can render payloads
produced by a server. The background watcher cannot use the browser's message
store when the UI is closed. Manual AI rename uses that store through
`SessionMessageLoader`; these are intentionally different retrieval lifecycles.
