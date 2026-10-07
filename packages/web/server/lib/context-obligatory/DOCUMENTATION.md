# Context Obligatory Messages

Messages explicitly pinned by the user are stored under
`session.metadata.openchamber.context_obligatory_messages` as `{ id, createdAt,
role }`. The UI uses a fresh-read metadata merge when pinning or unpinning.

The server runtime listens for `session.compacted`. The runtime finds the
newest completed `compaction` message on the session's canonical `{ info, parts }`
page (served by the OMP host), reads every pinned message from that same page,
keeps non-empty text content, and sorts them by the stored creation time.
Restoring the context needs OpenCode's synthetic message, which OMP has no
surface for: OMP's prompt carries one authored text and would reclassify the
context as the user's own turn, so the runtime fails with `OmpUnsupportedError`
(`code: OMP_UNSUPPORTED`, status 501) instead of sending it. Missing individual
messages are skipped without discarding the remaining context. Other events
perform no work and make no requests.

A cursor (`context_obligatory_last_compaction_message_id`) would prevent a
replayed compaction event from reinjecting the same summary, but it is only
written after a successful send — and no OMP send exists, so it is never
advanced and an OMP equivalent would re-inject rather than skip. The runtime is
owned by the OpenChamber web backend and therefore is not available in
extension-only VS Code mode.
