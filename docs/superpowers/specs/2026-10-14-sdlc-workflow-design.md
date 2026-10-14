# SDLC workflow runs (web + electron)

Status: approved design, 2026-10-14. Owner: maintainer.

## Context

The ask: a group of screens for the steps of an SDLC process, able to run several
steps as one workflow, with clear checkpoints, resumable after a stop or a
restart, and a screen that shows the workflow.

Nothing of the kind exists in this tree. The token `checkpoint` has no match in
`packages/ui/src` or `packages/web/server`. The plan documents under
`docs/superpowers/plans/` are prose written for an agent to read, and the only
markdown plan parser in the repo takes the first heading and treats the rest as
a body (`packages/ui/src/lib/projectContextApi.ts:83`,
`packages/web/server/lib/project-context/runtime.js:124`). Five features sit
near the idea without being it: the plan surface
(`packages/ui/src/components/views/PlanView.tsx`), project notes/todos/plans
(`packages/web/server/lib/project-context/`), session goals
(`packages/web/server/lib/session-goal/`), scheduled tasks
(`packages/web/server/lib/scheduled-tasks/`), and multi-run with auto review
(`packages/ui/src/stores/useAutoReviewStore.ts`). None of them runs a sequence
of steps declared in a definition.

Building blocks to reuse instead of writing a second copy of each:

| Need | Existing code |
|---|---|
| Create a session and send a prompt with no UI open | `promptSession` and `getOmpRuntimeHost` in `packages/web/server/lib/agents/omp-host-access.js:35-65`, used by `packages/web/server/lib/scheduled-tasks/runtime.js:520` and by `POST /api/openchamber/sessions` |
| Know that a turn ended | `packages/web/server/lib/session-goal/runtime.js:3` reacts to a busy to idle transition; `GET /api/agents/omp/sessions/:id/status` reports `busy` |
| Store server state with a per-project lock and atomic writes | `packages/web/server/lib/project-context/runtime.js` |
| Register a top level screen | `packages/ui/src/lib/surfaces/registry.ts:31-160`, with `lib/surfaces/modes.ts` and the render switch in `components/layout/ContextPanel.tsx:1077-1090` |
| Push live updates to the UI | frame `openchamber:omp` on `/api/openchamber/events` (`packages/web/server/lib/agents/omp-runtime-host.js:21`, allow listed at `packages/web/server/index.js:192`) |
| A banner for a decision that belongs to the open session | `packages/ui/src/components/chat/AutoReviewBanner.tsx` |
| Sidebar rows grouped by a run | `packages/ui/src/components/session/sidebar/sessions/RunSidebarRow.tsx` |

Four properties of OMP shape the design. They are facts about the runtime, not
choices open to this work:

1. No revert and no per-turn diff (`packages/ui/src/lib/agent/omp-runtime.ts:47-88`).
   A checkpoint cannot be an internal snapshot of the agent, so it has to be a
   git commit, a copied artifact, or both.
2. Subagents are invisible. `isSubagentTool("task")` is false
   (`packages/ui/src/lib/opencode/tools.ts:36,269`) and the adapter skips
   depth-2 transcripts (`packages/omp-adapter/src/session-store.ts:114-117`).
   A run built as one session that splits its own work hides the per-step
   progress these screens exist to show.
3. `createSession` takes `cwd` and nothing else
   (`packages/web/server/lib/agents/omp-routes.js:33-38`). The model is set
   after creation and agent selection is unsupported (`agentSelection: false`),
   so a step describes itself with a prompt or a skill, never with an agent
   name.
4. A session belongs to one directory, so a step can adopt an existing session
   only when that session's `cwd` is the run's directory.

### Decisions taken in the design session

1. The runner lives in the server, and the UI decides how far it goes: run one
   step, or run until the next stop.
2. A person confirms each step. When the turn ends the step waits; the person
   either confirms it is done or types another prompt, which continues the same
   session as a new attempt in the same step.
3. The sandbox is declared per workflow (`sandbox: worktree | working-tree`) and
   defaults to `worktree`. Until worktree mode exists (P4) the schema does not
   declare the field, so no definition can ask for behavior the code lacks.

## Goals

- Run a declared sequence of steps against one project, driven from the UI, one
  step at a time or continuously until the next stop.
- Make each step's evidence checkable: artifacts on disk, command exit codes, a
  git commit, and the transcript of the attempt that produced it.
- Resume after a server restart by rebuilding from evidence, and mark anything
  uncertain as interrupted rather than assuming it finished.
- Show the workflow and its live state on one screen, with the decisions a
  person has to make in front of them.
- Keep the engine drivable and testable without the UI, through routes.

## Non-goals

- Parallel steps. Steps run in order.
- A general graph engine with conditional branches. A definition is a sequence,
  and a step can be skipped.
- Syncing runs between machines. Session ids and run state are local to the
  machine that produced them.
- Replacing or merging session goals, scheduled tasks, multi-run, or auto
  review. This work borrows their building blocks and changes none of them.
- Confirming a step on a person's behalf. A workflow that needs nobody declares
  `confirm: auto` with a verifier.
- A definition editor in the first phases. Definitions are YAML files, with a
  template to copy.
- Merging a worktree automatically. The merge is a step someone runs.
- `packages/vscode` and `packages/mobile`. The screens live in shared UI and
  both packages are out of scope for this fork
  (`docs/superpowers/specs/2026-10-07-omp-only-runtime-design.md`). Neither is
  validated by this work.

## Architecture

```
Screens (packages/ui)
  workflows surface: run list, run detail, chat banner
    | HTTP /api/workflows/*          ^ SSE frame openchamber:workflow
    v                                |
  packages/web/server/lib/workflows/
    routes.js
      |
    engine.js --- definitions.js   (<repo>/.openchamber/workflows/*.yaml)
      |---- store.js               (<projectsDir>/<project stem>/workflow-runs/*.json)
      |---- verifiers.js           (artifacts, commands)
      |---- prompts.js             (prompt block assembly, shared)
      |
    OMP runtime host (packages/web/server/lib/agents/omp-runtime-host.js)
      |
    one `omp` session per step attempt
```

## Domain model

A definition is a YAML file at `<repo>/.openchamber/workflows/<id>.yaml`. The
repository already keeps shared planning files in `<repo>/.openchamber/plans`,
so this follows the same habit.

```yaml
id: sdlc-feature
name: SDLC, feature work
version: 3
inputs:
  - name: request
    description: What to build, in the requester's words
    required: true
steps:
  - id: spec
    title: Design the change
    prompt: "Design {{request}} and write the design to docs/superpowers/specs/."
    session: new            # new | reuse
    permissions: ask        # ask (default) | auto
    verify:
      artifacts:
        - glob: "docs/superpowers/specs/*-design.md"
          hash: true
    confirm: human          # human (default) | auto

  - id: plan
    title: Write the implementation plan
    prompt: "Read the approved spec in this session and write the plan."
    session: reuse
    verify:
      artifacts: ["docs/superpowers/plans/*.md"]
    confirm: human

  - id: verify
    title: Verify the branch
    prompt: "Run the checks the plan names and report what failed."
    session: reuse
    verify:
      commands: [{ run: "bun run type-check:web", expectExit: 0 }]
    confirm: auto
```

Field notes:

- `inputs` are declared by the definition and get their values when a run is
  created. `{{name}}` in a prompt is substituted before the prompt is sent. A
  placeholder with no declared input is a load error, not an empty string.
- `session: reuse` continues the session of the previous attempt in the same run
  instead of opening one. This is what makes "prompt tiếp" keep its context.
- `permissions: ask` (the default) leaves tool approvals to the person. The
  request appears in the existing permission dock for that session and the step
  reports `blocked` until it is answered. `permissions: auto` enrolls the session
  the way scheduled tasks do
  (`packages/web/server/lib/scheduled-tasks/runtime.js:600-606`), and is for a
  step someone has decided to leave unattended.
- `verify.artifacts` takes a glob string, or an object with `glob` and `hash`.
  `hash: true` records the size and sha256 of each match and re-checks it on
  resume, which suits an artifact that should not change once approved, such as a
  spec or a plan. A plain string checks existence only, which suits a file the
  step regenerates.
- `verify.commands` runs in the run's directory with a timeout and passes on the
  expected exit code. Its `stdout` and `stderr` are stored on the attempt, so a
  screen shows what ran instead of what a model said about it.
- `confirm: auto` without a verifier is rejected when the definition loads. A
  step that advances on its own with nothing to check is a guess.

Run state holds four things: the run, its steps, the attempts inside each step,
and the checkpoint a confirmation writes.

Step states: `pending`, `running`, `waiting_confirm`, `needs_work`, `done`,
`failed`, `skipped`, `blocked`, `interrupted`.

`blocked` means the run is waiting on a person for something that is not the
step's own verdict: a tool approval, a provider that refused the model, or a
session whose directory is not the run's. It clears when the person answers and
never counts as a failure, so a run stopped by a missing model does not read as
broken.

Transitions:

1. The engine creates or adopts the session, sends the prompt, and waits for the
   turn to end (busy to idle).
2. The engine runs the step's verifiers and records each result on the attempt.
3. `confirm: auto` with every verifier passed: the step becomes `done` and the
   engine writes its checkpoint.
4. `confirm: human`: the step becomes `waiting_confirm` and the screen offers
   four actions.
   - Confirm done. The engine writes the checkpoint, records the step as `done`,
     and the run moves on.
   - Send another prompt. A new attempt starts in the same session and the step
     returns to `running`.
   - Skip the step. It is recorded as `skipped` with a reason and does not run
     again in this run.
   - Stop the run.
5. A verifier that fails, or "not done" with no further prompt, puts the step in
   `needs_work` with the failure recorded. `needs_work` and `waiting_confirm`
   are both stops.
6. A turn error, or a prompt the runtime refused, fails the attempt. When the
   runtime answers that it did not take the prompt (`promptSession` returning
   anything but `true`), nothing is recorded as sent, following
   `packages/web/server/lib/scheduled-tasks/runtime.js:519-527`.
7. A tool approval waiting, a provider that refused the model, or a session
   whose directory is not the run's puts the step in `blocked` with the reason
   on the attempt. The run does not advance, and nothing is recorded as a failed
   step. Answering the approval in the session's permission dock, or picking a
   model that works, clears the block.

Consequence to keep in view: "run the whole workflow" runs until the first stop.
A `confirm: human` step stops it on purpose, and so does a `blocked` step that
needs a person. An unattended run needs every step to declare `confirm: auto`
with a verifier, `permissions: auto`, and a model that answers.

## Components

### `packages/web/server/lib/workflows/` (new)

- `definitions.js` reads and validates the definition files for a project.
  Validation errors come back per file with the field that failed, so a broken
  definition shows up on screen instead of disappearing. Deleting a definition
  leaves its runs alone.
- `store.js` owns run state on disk: one file per run, written atomically, with
  a per-project lock in the manner of
  `packages/web/server/lib/project-context/runtime.js`.
- `engine.js` drives a run: resolve the step, create or adopt the session,
  assemble and send the prompt, wait for the turn, run the verifiers, persist,
  then stop or advance. One run per project is active at a time, following the
  running-key guard in `packages/web/server/lib/scheduled-tasks/runtime.js`.
- `verifiers.js` implements the artifact and command checks and reports a result
  per check, never one pass or fail for the whole step.
- `prompts.js` holds prompt block assembly for the engine. The same assembly
  lives inside `packages/web/server/lib/scheduled-tasks/runtime.js`, where slash
  commands have to lead the text and context follows. That code moves here and
  both callers use it, so the fork keeps one convention rather than two.
- `routes.js` exposes the routes below and broadcasts workflow frames on the
  OpenChamber control stream.

### `packages/ui` (new screen group)

- `lib/workflows/schema.ts` mirrors the definition shape for the UI, the way
  `lib/projectContextApi.ts` mirrors
  `packages/web/server/lib/project-context/routes.js`.
- `lib/workflowsApi.ts` is the HTTP client for `/api/workflows/*`.
- `stores/useWorkflowStore.ts` caches runs per project and applies stream
  updates.
- `components/views/workflows/` holds the run list, run detail, step timeline,
  step pane, checkpoint view and definition diagram.
- `lib/surfaces/registry.ts`, `lib/surfaces/modes.ts` and
  `components/layout/ContextPanel.tsx` gain the `workflows` screen.
- New text goes into all 13 locales under `packages/ui/src/lib/i18n/messages/`:
  de, en, es, fr, ja, ko, nl, pl, pt-BR, tr, uk, zh-CN, zh-TW.

## Data flow

1. A screen calls `POST /api/workflows/runs/:runId/steps/:stepId/run`.
2. The engine loads the definition, resolves the step, and asks the runtime host
   for a session: a new one with the run's directory, or the session recorded on
   the previous attempt.
3. The engine sends the prompt through the shared host access, waits for the
   turn to end, then runs the verifiers.
4. The engine writes the attempt and the step state to the run file and
   broadcasts an `openchamber:workflow` frame.
5. The screen applies the frame to the store and renders the new step state.
6. On confirmation, the engine writes the checkpoint (artifacts plus a git commit
   whose message carries `[run=<runId> step=<id> attempt=<n>]`), marks the step
   done, and broadcasts again.

## Storage and resume

Two kinds of data, kept apart on purpose.

Artifacts and commits are the record. They live in the repository and in git,
and read fine without this feature. The commit message carries the run id and
the step id, so git history is the checkpoint chain. A checkpoint records the
commit holding the step's changes, and the verified artifacts with their hashes.
When the working tree is already clean the engine records the current HEAD rather
than creating an empty commit.

Run state is an index, local to the machine, at
`<projectsDir>/<projectConfigFileStemOf(projectId)>/workflow-runs/<runId>.json`, the same projects
directory project context already uses (`packages/web/server/index.js:573-578`).
Session ids mean something only on the machine that created them, so run state
stays out of the repository.

Resume runs at server start for every run that is not done, failed or cancelled,
and rebuilds from evidence instead of trusting the file:

- A step that was `running` when the server died becomes `interrupted`. The
  engine does not assume the turn finished.
- Every recorded checkpoint is re-checked: the commit exists, and the hashed
  artifacts still match. A mismatch shows on the screen and blocks that step
  from advancing.
- The step's session is looked up in `host.listSessions()`. A busy session is
  reattached and watched. An idle session means the last turn ended, so the
  verifiers and the person decide what that means.

## Routes and events

```
GET    /api/workflows/definitions                    definitions with validation errors
GET    /api/workflows/runs                           runs for the project
POST   /api/workflows/runs                           create a run with its input values (does not start it)
GET    /api/workflows/runs/:runId                    full state: steps, attempts, checkpoints
POST   /api/workflows/runs/:runId/run                run until the next stop
POST   /api/workflows/runs/:runId/cancel
DELETE /api/workflows/runs/:runId                    the run file only; commits, artifacts and sessions stay
POST   /api/workflows/runs/:runId/steps/:id/run      run this step
POST   /api/workflows/runs/:runId/steps/:id/prompt   another prompt in the same session
POST   /api/workflows/runs/:runId/steps/:id/verify   re-run the verifiers
POST   /api/workflows/runs/:runId/steps/:id/confirm  done | not_done | skip
```

Deleting a run removes one run file whose id the caller had to name. It does not
delete commits, artifacts, or the sessions the run created, and no route deletes
a session by pattern.

Frames of type `openchamber:workflow` are broadcast on
`/api/openchamber/events`, following `openchamber:omp`. Screens update from the
stream and do not poll.

Project scope uses the path-derived project id project context already uses
(`createProjectIdFromPath`).

## Screens

One rail entry, `workflows`, registered in
`packages/ui/src/lib/surfaces/registry.ts`. It stays available on a project with
no workflow yet, with an empty state that points at the definition directory; a
`has-content` rule would leave a new project with no way in. The existing
"Configure panels" dialog can hide or reorder it.

- Run list: each run's workflow and version, status, current step, sandbox, and
  last update, with actions to open, continue, cancel or delete.
- Run detail: the step sequence down the left with a status color per step and
  the selected step on the right. The timeline is built from theme tokens and
  not from a diagram renderer, because live status changes on every frame and
  re-rendering a full SVG each time is wasted work.
- Step pane: the attempts, each linked to its session transcript; the verifier
  results with real command output; the checkpoint with commit, artifacts,
  hashes and diff; the prompt box for "prompt tiếp"; and the four actions.
- Definition diagram: a separate read-only tab that draws the declared workflow
  with `beautiful-mermaid`, already a dependency. It describes structure, not
  live state.
- Chat banner: shown when the open session belongs to an attempt, in the manner
  of `AutoReviewBanner.tsx`, offering confirm and continue there.
- Sidebar: the sessions a run created, grouped in the manner of the multi-run
  rows.

## Phases

The phases are separate pieces of work, not one sitting. P1 and P2 form the first
implementation plan, because the engine is not worth having without resume. P3
and P4 each get their own plan once the one before lands, and P5 stays deferred
until someone asks for it.

### P1: engine, routes, state (working tree)

- `definitions.js`, `store.js`, `engine.js`, `verifiers.js`, `prompts.js`,
  `routes.js`.
- Execution in the project's working tree. The `sandbox` field is not declared
  yet, so no definition can request a mode the code does not implement.
- Confirmation and the continue prompt are driven through routes. No screen yet.
- Validation: node tests for the state machine, the verifiers and the store,
  then a real run of a two-step fixture definition on a scratch git repository,
  driven through the routes against a real `omp` binary.

### P2: resume

- Boot reconciliation, interrupted steps, checkpoint re-verification against git
  and artifact hashes, session reattachment.
- Validation: tests with a fake host and a temporary repository, plus killing the
  server mid-turn and restarting it.

### P3: screens

- The rail entry, run list, run detail, step pane, definition diagram, chat
  banner, sidebar grouping, `openchamber:workflow` frames, and the locale text.
- Validation: a real run driven from the browser, with each state observed:
  running, waiting for a person, needs work, done.

### P4: worktree sandbox

- The `sandbox` field with `worktree` as the default, worktree and branch
  creation per run, and the merge back as an explicit final step.
- Validation: one run in each mode, and a measurement of worktree setup cost
  (dependency install, build cache) before `worktree` ships as the default.

### P5: definition authoring (deferred)

- A screen to create and edit definitions, plus a shipped SDLC template.
  Deferred because a template file and the existing editor cover the first need.

## Testing strategy

- Server tests cover the transitions that can go wrong: auto with a passing
  verifier, auto with no verifier rejected at load, the human stop, a continue
  prompt in the same session, a refused prompt, an interrupted step, a checkpoint
  whose hash no longer matches, and one run per project. Verifiers are tested
  against temporary directories: hashing, glob matching, timeout, expected exit
  code.
- The engine takes its host as an argument, so a test drives the whole loop with
  no model.
- UI tests cover the state derivation the screens depend on, not render output.
  Click paths are covered by the browser smoke below.
- Required before this is called working: a two-step fixture definition on a
  scratch repository, run against the real `omp` binary. Step one advances on its
  own with a verifier over a temporary file; step two waits for a person.
  Observed end to end: create, run, verifier pass, stop at the gate, continue
  prompt, confirm, checkpoint commit present.
- Static checks prove nothing here. The routes, the session behavior and the
  resume path are exercised on a running server.

## Risks

- Cost. Each step gets its own session, so context is not shared unless a step
  declares `session: reuse`. A short step can cost more than the same work inside
  one long session.
- A provider that refuses the model mid-run (the free-tier 403 seen from OMP) has
  to land as `blocked`, not as a failed step, or a run looks broken when it is
  only waiting for a person to pick a model.
- Artifacts that get regenerated change their hash. Hashing has to stay limited
  to artifacts meant to be stable, or a passing step reads as broken.
- A worktree per run is expensive on a large repository. Measuring the setup cost
  belongs in P4, before the default lands.
- `promptSession` answers `true` or `null`, and a scheduled task treats the send
  as the end of the task. Copying that pattern would mark steps done that never
  ran; the engine waits for the turn.
- The step pane duplicates parts of the chat renderer if it is written from
  scratch. Reuse the message rendering path where a transcript is shown.

## Open questions

- Should a step own its session or only link to it? The current answer is link:
  the attempt records a session id and the same session stays reachable from the
  chat sidebar.
- In worktree mode, is the final merge a step in the YAML or a built-in action on
  the run? Leaning to a step, so the definition says what happens.
- Do checkpoint commits land on the run's branch only (worktree mode) or on the
  current branch (working tree mode), and should they be tagged?
- Should `session: reuse` become the default for consecutive steps, since it
  saves context?
- How much of the run list belongs in the sidebar next to sessions, and how much
  in the workflows screen?
