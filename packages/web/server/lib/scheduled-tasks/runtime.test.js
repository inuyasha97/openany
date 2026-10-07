import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { configureOmpRuntimeHost } from '../agents/omp-host-access.js';

describe('scheduled-tasks runtime helpers', () => {
  it.each([
    ['*/15 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:15:00Z'],
    ['30 */5 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:10:30Z'],
    ['0 9 * * MON-FRI', 'Europe/Kyiv', '2026-09-18T07:00:00Z', '2026-09-21T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-03-28T08:00:00Z', '2026-03-29T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-10-24T08:00:00Z', '2026-10-25T07:00:00Z'],
    ['0 0 L * *', 'UTC', '2026-02-01T00:00:00Z', '2026-02-28T00:00:00Z'],
  ])('computes cron %s in %s from %s', (cron, timezone, now, expected) => {
    expect(computeNextRunAt({
      enabled: true,
      schedule: { kind: 'cron', cron, timezone },
    }, Date.parse(now))).toBe(Date.parse(expected));
  });

  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncProject wiring', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOpenCodeUrl: () => 'http://localhost',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    ...overrides,
  });

  it('reconciles discovered loops when the project path is known', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    try {
      await writeFile(path.join(repoPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });

      await runtime.syncProject('proj');

      const tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('loop:project:daily');
      expect(tasks[0].loopFile).toBe(path.join(repoPath, '.agents', 'loops', 'daily.md'));
      // syncTaskSchedule computed and persisted the next run for the enabled task.
      expect(tasks[0].state.nextRunAt).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('falls back to plain listing when the project path cannot be resolved', async () => {
    const { tempRoot, cleanup } = await createTempProject();
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const reconcileSpy = vi.spyOn(projectConfigRuntime, 'reconcileLoopTasks');
      const listSpy = vi.spyOn(projectConfigRuntime, 'listScheduledTasks');

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        // Project not registered -> ensureProjectPath cannot resolve a path.
        listProjects: async () => [],
      });

      await runtime.syncProject('proj');

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledWith('proj');
      expect(await projectConfigRuntime.listScheduledTasks('proj')).toEqual([]);
      reconcileSpy.mockRestore();
      listSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('scheduled-tasks runtime syncAllProjects', () => {
  it('keeps scheduling the other projects when one project cannot be synced', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-sync-all-'));
    try {
      const brokenPath = path.join(tempRoot, 'broken');
      const healthyPath = path.join(tempRoot, 'healthy');
      await mkdir(path.join(healthyPath, '.agents', 'loops'), { recursive: true });
      await mkdir(brokenPath, { recursive: true });
      await writeFile(path.join(healthyPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = createProjectConfigRuntime({
        fsPromises: await import('fs/promises'),
        path,
        projectsDirPath: path.join(tempRoot, 'config'),
        createTaskID: () => 'task-fixed-id',
      });
      await mkdir(path.join(tempRoot, 'config'), { recursive: true });
      await writeFile(projectConfigRuntime.resolveProjectConfigPath('broken'), '{ not json', 'utf8');

      const warnings = [];
      const runtime = createScheduledTasksRuntime({
        buildOpenCodeUrl: () => 'http://localhost',
        getOpenCodeAuthHeaders: () => ({}),
        waitForOpenCodeReady: async () => {},
        projectConfigRuntime,
        listProjects: async () => [
          { id: 'broken', path: brokenPath },
          { id: 'healthy', path: healthyPath },
        ],
        logger: { warn: (...args) => warnings.push(args) },
      });

      await expect(runtime.start()).resolves.toBeUndefined();

      expect(runtime.getStatus().enabledScheduledTasksCount).toBe(1);
      const healthyTasks = await projectConfigRuntime.listScheduledTasks('healthy');
      expect(healthyTasks.map((task) => task.id)).toEqual(['loop:project:daily']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toMatchObject({ projectID: 'broken' });
      runtime.stop();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('scheduled-tasks runtime prompt dispatch', () => {
  afterEach(() => {
    configureOmpRuntimeHost(null);
  });

  const createHost = () => ({
    createSession: vi.fn(async () => ({ id: 'ses_run' })),
    renameSession: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => true),
    listCommands: vi.fn(async () => []),
  });

  const createTask = (execution, prompt = 'Review open issues') => ({
    id: 'task-1',
    name: 'Nightly',
    enabled: true,
    schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
    execution: { prompt, providerID: 'openai', modelID: 'gpt-5', ...execution },
    state: { createdAt: 1, updatedAt: 1 },
  });

  const createRuntime = (task, overrides = {}) => createScheduledTasksRuntime({
    projectConfigRuntime: {
      listScheduledTasks: async () => [task],
      reconcileLoopTasks: async () => [task],
      updateScheduledTaskState: async () => ({ task, updated: true }),
      updateScheduledTaskStateIf: async () => ({ task, updated: true }),
    },
    listProjects: async () => [{ id: 'proj', path: '/repo' }],
    persistSessionGoal: async () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  });

  it('sends the standing briefing and the goal intro with the task prompt', async () => {
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const recordDelivered = vi.fn(async () => undefined);
    const runtime = createRuntime(
      createTask({ goalEnabled: true, goalTokenBudget: 50_000 }),
      {
        sessionKnowledgeRuntime: {
          resolvePendingForSession: async () => ({ text: 'Project background', signature: 'sig' }),
          recordDelivered,
        },
      },
    );

    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(host.createSession).toHaveBeenCalledWith({ cwd: '/repo' });
    // OMP takes only the directory at create, so the title the run formats goes
    // on the session right after it exists.
    expect(host.renameSession).toHaveBeenCalledWith('ses_run', expect.stringMatching(/^Nightly \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
    expect(host.setModel).toHaveBeenCalledWith('ses_run', 'openai', 'gpt-5');

    // One authored turn, with the context that used to precede it as parked
    // synthetic messages carried in front of the prompt instead.
    expect(host.prompt).toHaveBeenCalledTimes(1);
    const [promptSessionID, text] = host.prompt.mock.calls[0];
    expect(promptSessionID).toBe('ses_run');
    expect(text).toContain('Project background');
    expect(text).toContain('Goal mode is active for this session.');
    expect(text).toContain('Review open issues');
    expect(text.indexOf('Project background')).toBeLessThan(text.indexOf('Goal mode is active'));
    expect(text.indexOf('Goal mode is active')).toBeLessThan(text.indexOf('Review open issues'));
    expect(recordDelivered).toHaveBeenCalledWith('ses_run', '/repo', 'sig');
    expect(result).toMatchObject({ ok: true, status: 'success', sessionID: 'ses_run' });
  });

  it('fails a slash-command task instead of sending the raw command text', async () => {
    const host = createHost();
    host.listCommands = vi.fn(async () => [{ name: 'review' }]);
    configureOmpRuntimeHost(() => host);
    const runtime = createRuntime(createTask({}, '/review src/components'));

    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cannot use the "\/review" command: the OMP runtime has no equivalent/);
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('fails a task pinned to an agent or a model variant the runtime cannot apply', async () => {
    const host = createHost();
    configureOmpRuntimeHost(() => host);
    const runtime = createRuntime(createTask({ agent: 'plan', variant: 'high' }));

    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cannot use the "plan" agent: the OMP runtime has no equivalent/);
    // Nothing was dispatched: the session is not opened for a run it cannot honor.
    expect(host.createSession).not.toHaveBeenCalled();
  });
});
