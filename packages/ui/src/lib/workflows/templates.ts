/**
 * The SDLC workflow a person can start a definition from.
 *
 * A definition is a file in the project, so a template is only ever a starting
 * point: the pane that copies it asks for the id that names the file first, and
 * the write refuses a name that is already on disk. A template that does not
 * load is worse than no template, so this one is pinned by the parser's own run
 * (`templates.test.ts`) and by the engine's parser in the task that shipped it.
 *
 * Every step stops for a person, because a step becomes done only when a person
 * confirms it; the steps that produce a file carry a verifier so the stop has
 * evidence beside it. The last step brings the work back, because a run in
 * worktree mode leaves a branch behind on purpose.
 */
export const SDLC_FEATURE_TEMPLATE = `id: sdlc-feature
name: SDLC, feature work
version: 1
inputs:
  - name: request
    description: What to build, in the requester's words
    required: true
sandbox: worktree
steps:
  - id: spec
    title: Design the change
    prompt: "Design {{request}} and write the design to docs/superpowers/specs/."
    session: new
    verify:
      artifacts:
        - glob: "docs/superpowers/specs/*-design.md"
          hash: true

  - id: plan
    title: Write the implementation plan
    prompt: "Read the approved design in this session and write the implementation plan to docs/superpowers/plans/."
    session: reuse
    verify:
      artifacts: ["docs/superpowers/plans/*.md"]

  - id: implement
    title: Implement the plan
    prompt: "Execute the plan you just wrote, one task at a time, committing as it says."
    session: reuse

  - id: verify
    title: Verify the branch
    prompt: "Run the checks the plan names and report what failed."
    session: reuse
    verify:
      commands:
        - run: "bun run type-check:web"
          expectExit: 0

  - id: bring-back
    title: Bring the work back
    prompt: "Summarize what changed, list the commits, and say what a reviewer should look at first."
    session: reuse
`;

/**
 * The template with the id a person typed in place of the one it ships with.
 *
 * The id in the body is what the route compares against the file it is writing,
 * so a seed that kept `sdlc-feature` would be refused for every other name the
 * person chose. Only the `id:` line is substituted: the rest of the template is
 * the text a person is expected to edit, and this function is not where they
 * would expect it to change.
 */
export const sdlcTemplateFor = (workflowId: string): string =>
  SDLC_FEATURE_TEMPLATE.replace(/^id: .+$/m, `id: ${workflowId}`);

/**
 * A row for a definition that has not been written yet. It carries no hash and
 * no parsed body — there is no file to read — so the only thing it states is
 * what the write will name the file.
 */
export const sdlcTemplateSummary = (workflowId: string): { id: string; file: string } => ({
  id: workflowId,
  file: `${workflowId}.yaml`,
});
