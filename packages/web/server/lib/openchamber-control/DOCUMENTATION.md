# OpenChamber Control Service

## Purpose

This module owns the typed control contract shared by the OpenChamber CLI and
the managed OpenCode `openchamber` tool. Both adapters delegate to
`createOpenChamberControlService()`; neither adapter may call or spawn the
other.

## Boundaries

- `service.js` validates and executes the fixed project, model, session, and
  scheduled-task action allowlist. `actions.js` marks CLI-only actions with
  `agentExposed: false` (currently `schedule.status`); the agent tool consumes
  the filtered `OPENCHAMBER_AGENT_TOOL_*` exports. `schedule.toggle` requires
  the `disabled` boolean and replaces separate enable/disable actions;
  `schedule.list` also returns scheduler status as `scheduler`.
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action,
  preserves service status and partial-result details, and propagates request
  cancellation.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service
  results in the versioned native-tool envelope and uses a separate ephemeral
  loopback credential.
- `../openchamber-sessions/routes.js` and `../scheduled-tasks/service.js` own
  their domain operations and are composed into this service.

## Invariants

- Session reads come from the OMP runtime host
  (`../agents/omp-host-access.js`): `session.list` lists the runtime's own
  sessions filtered by their `cwd`, `session.status` reports one session's busy
  flag as `busy`/`idle`, and `session.messages` reads that session's message
  page. Message output includes only ordered `text` parts.
- An unmounted runtime is a failure (503), never an empty session list, an idle
  session, or a message-less session. A read that fails propagates instead of
  reading as "no messages".
- `session.create`, `session.send`, and `session.fork` need a create, prompt,
  and fork the runtime seam does not expose, so they answer 501 naming the
  action. The actions stay in the contract so a CLI or agent-tool caller learns
  why they cannot run instead of waiting for work that never starts.
- Wait never reports idle on a timeout: it polls the runtime's busy flag and
  otherwise fails on the elapsed timeout or the caller's cancellation (499). A
  session already idle when the wait begins is idle.
- Usage errors name the missing or conflicting input so CLI and agent-tool
  callers can correct an invalid request without an upfront usage manual.
- Explicit `projectId` or `directory` scope takes precedence over the managed
  tool's current-session directory fallback; the fallback never creates a
  conflicting second scope.
- One session's failed status lookup produces `unknown` for that session and
  does not erase the other session results.
- Destructive session/worktree deletion and project-path registration are not
  part of the action contract.
- `file.open` shows a file in the user's viewer. `file-open.js` resolves a
  relative path against the session directory (an explicit `directory` wins),
  refuses a relative path with no directory at all, checks the target is an
  existing file, then hands `{ path, directory, sessionId }` to the injected
  `emit`, which `index.js` writes to every UI control stream as
  `openchamber:file-open-request`. Nothing comes back: opening a tab does not
  fail quietly on a client, so the count of clients reached is the signal, and
  zero is a 503, never a claimed success. Paths outside the workspace are
  allowed on purpose: screenshots and recordings often land in a temp
  directory, and the viewer already reads such files.
- `browser.capture` writes its image on the server, into
  `.openchamber/screenshots/` under the scoped project directory, and returns
  the project-relative path rather than the image bytes. The client that took
  the picture may be on a different machine than the repository, and a path is
  what an answer, a commit, or a review can use; base64 in a tool result cannot
  be any of those. The agent's label is reduced to a filename fragment, never
  used as a path. The result also states how to present the image, because chat
  renders the image paths written in a finished answer below that message —
  saving the file is not what shows it to anyone.
