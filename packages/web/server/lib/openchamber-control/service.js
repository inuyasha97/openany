import path from 'node:path';
import { readSessionMessages, readSessionStatus, readSessions } from '../agents/omp-host-access.js';
import { OpenChamberControlError, asControlError } from './error.js';
import { OPENCHAMBER_ALL_ACTIONS } from './actions.js';
import { writeScreenshot } from './screenshots.js';

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
// One service, both capabilities: which tool asked is the caller's concern.
const CONTROL_ACTIONS = new Set(OPENCHAMBER_ALL_ACTIONS);
const SCHEDULE_TASK_ID_ACTIONS = new Set([
  'schedule.run',
  'schedule.delete',
  'schedule.toggle',
]);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// A configured project path and a session's recorded working directory can
// differ only in shape (a trailing separator, a symlinked or otherwise
// unnormalized path), and a scoped list must not come back empty over that.
const sameDirectory = (left, right) => {
  const a = asNonEmptyString(left);
  const b = asNonEmptyString(right);
  if (!a || !b) return false;
  return a === b || path.resolve(a) === path.resolve(b);
};

const positiveInteger = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new OpenChamberControlError(`${field} must be a positive integer`, 400);
  }
  return number;
};

const normalizeWaitTimeoutMs = (value) => {
  const seconds = value === undefined || value === null ? DEFAULT_WAIT_TIMEOUT_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new OpenChamberControlError(`timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds * 1000;
};

// A message page carries `{ info, parts }`: what a caller can read as text is
// the message's text parts, joined in the order they arrived.
const messageText = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

const extractTextMessages = (items, role = 'all') => {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const info = item?.info;
    const messageRole = info?.role;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) continue;
    const text = messageText(item?.parts);
    if (!text) continue;
    const providerID = asNonEmptyString(info.providerID);
    const modelID = asNonEmptyString(info.modelID);
    result.push({
      id: asNonEmptyString(info.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(info?.time?.created) ? info.time.created : null,
      completedAt: Number.isFinite(info?.time?.completed) ? info.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    });
  }
  return result.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

const parseModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) throw new OpenChamberControlError('model is required', 400);
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new OpenChamberControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const parseWeekdays = (value) => {
  const raw = asNonEmptyString(value);
  if (!raw) throw new OpenChamberControlError('weekly is required', 400);
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new OpenChamberControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (input) => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  const selectors = [daily, weekly, once, cron].filter(Boolean);
  if (selectors.length !== 1) {
    throw new OpenChamberControlError('Provide exactly one of daily, weekly, once, or cron', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) return { kind: 'daily', times: [daily], ...(timezone ? { timezone } : {}) };
  if (weekly) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with weekly', 400);
    return { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time], ...(timezone ? { timezone } : {}) };
  }
  if (once) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with once', 400);
    return { kind: 'once', date: once, time, ...(timezone ? { timezone } : {}) };
  }
  return { kind: 'cron', cron, ...(timezone ? { timezone } : {}) };
};

const buildScheduledTask = (input) => {
  const name = asNonEmptyString(input.name);
  const prompt = asNonEmptyString(input.prompt);
  if (!name) throw new OpenChamberControlError('name is required', 400);
  if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
  const model = parseModel(input.model);
  const goalTokenBudget = input.goalTokenBudget;
  if (goalTokenBudget !== undefined && input.goal !== true) {
    throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
  }
  if (goalTokenBudget !== undefined && (!Number.isSafeInteger(goalTokenBudget) || goalTokenBudget < 1000 || goalTokenBudget > 100_000_000)) {
    throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
  }
  return {
    name,
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt,
      ...model,
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(input.goal === true ? { goalEnabled: true } : {}),
      ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    },
  };
};

export const createOpenChamberControlService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    scheduledTaskService,
    browserControl = null,
    fileOpen = null,
    notifyUser = null,
    agentMemoryActions = null,
    // Archive lives in OpenChamber's own store now — the runtime has no route
    // that sets a session's archived time — so an unwired store simply means
    // nothing is archived.
    archiveStore = null,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  } = dependencies;

  const wait = (duration, signal) => {
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new OpenChamberControlError('OpenChamber action was cancelled', 499));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new OpenChamberControlError('OpenChamber action was cancelled', 499));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      sleep(duration).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  };

  const archivedAt = (sessionID) => {
    if (!archiveStore || typeof archiveStore.isArchived !== 'function') return null;
    return archiveStore.isArchived(sessionID) || null;
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
    }));
  };

  const models = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return {
      defaultModel: asNonEmptyString(settings?.defaultModel),
      defaultVariant: asNonEmptyString(settings?.defaultVariant),
      defaultAgent: asNonEmptyString(settings?.defaultAgent),
      favoriteModels: Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : [],
      recentModels: Array.isArray(settings?.recentModels) ? settings.recentModels : [],
    };
  };

  // The action contract stays busy/idle; the runtime answers one boolean per
  // session, and an unavailable runtime is a failure, never an idle session.
  const asPublicStatus = (busy) => (busy ? { type: 'busy' } : { type: 'idle' });

  const sessionStatus = async (sessionID) => {
    const status = await readSessionStatus(sessionID);
    if (!status) throw new OpenChamberControlError('The OMP runtime is not available', 503);
    return asPublicStatus(status.busy === true);
  };

  // The runtime hands back the session's message page; a caller's limit is the
  // newest text messages, which extractTextMessages has already ordered
  // oldest-first. A page that cannot be read is a failure, never no messages.
  const sessionMessages = async (sessionID, role, limit) => {
    const page = await readSessionMessages(sessionID);
    if (!page) throw new OpenChamberControlError('The OMP runtime is not available', 503);
    const messages = extractTextMessages(page.items, role);
    return limit === undefined ? messages : messages.slice(-limit);
  };

  // A wait polls the runtime's own busy flag: busy is activity, and the first
  // non-busy answer after it is the session going idle. Timeout and
  // cancellation are failures, never authoritative idle results.
  const waitForIdle = async ({ sessionID, timeoutMs, signal }) => {
    const deadline = now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw new OpenChamberControlError('OpenChamber action was cancelled', 499);
      const status = await sessionStatus(sessionID);
      if (status.type !== 'busy') return status;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new OpenChamberControlError(`Session did not become idle within ${Math.ceil(timeoutMs / 1000)} seconds`, 500);
      }
      await wait(Math.min(WAIT_POLL_INTERVAL_MS, remaining), signal);
    }
  };

  // The managed agent-tool plugin cannot report the session's directory (the
  // tool call carries only the session id), so it sends the id and the
  // directory is resolved here, from the runtime's own session index.
  const resolveSessionDirectory = async (sessionID) => {
    try {
      const sessions = await readSessions();
      const session = Array.isArray(sessions) ? sessions.find((item) => item?.id === sessionID) : null;
      return asNonEmptyString(session?.cwd) || null;
    } catch {
      return null;
    }
  };

  /**
   * Validates browser inputs here rather than in the renderer: an invalid call
   * should come back as a usage error the agent can correct, without waking a
   * client or waiting for a round trip.
   */
  const browserAction = async (action, input, signal, contextDirectory, contextSessionId) => {
    const parameters = {};
    // Any action may name a tab; the browser that issued the id resolves it.
    const tabId = asNonEmptyString(input.tabId);
    if (tabId) {
      if (tabId.length > 128) throw new OpenChamberControlError('tabId must be an id from browser.snapshot tabs', 400);
      parameters.tabId = tabId;
    }

    const readViewport = (required) => {
      const viewport = asNonEmptyString(input.viewport);
      if (!viewport) {
        if (required) throw new OpenChamberControlError('viewport is required for browser.resize', 400);
        return;
      }
      if (!['mobile', 'tablet', 'desktop', 'fill'].includes(viewport)) {
        throw new OpenChamberControlError('viewport must be mobile, tablet, desktop, or fill', 400);
      }
      parameters.viewport = viewport;
    };

    if (action === 'browser.resize') readViewport(true);

    if (action === 'browser.capture') {
      const label = asNonEmptyString(input.label);
      if (label) parameters.label = label;
    }

    if (action === 'browser.open') {
      readViewport(false);
      const url = asNonEmptyString(input.url);
      if (!url) throw new OpenChamberControlError('url is required for browser.open', 400);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new OpenChamberControlError('url must be an absolute http(s) URL', 400);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new OpenChamberControlError('url must use http or https', 400);
      }
      parameters.url = parsed.toString();
    }


    if (action === 'browser.click') {
      const selector = asNonEmptyString(input.selector);
      const text = asNonEmptyString(input.text);
      if (!selector && !text) {
        throw new OpenChamberControlError('browser.click requires selector or text', 400);
      }
      if (selector) parameters.selector = selector;
      if (text) parameters.text = text;
    }

    if (action === 'browser.snapshot') {
      const selector = asNonEmptyString(input.selector);
      if (selector) parameters.selector = selector;
    }

    if (action === 'browser.inspect') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new OpenChamberControlError('selector is required for browser.inspect', 400);
      parameters.selector = selector;
    }

    if (action === 'browser.type') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new OpenChamberControlError('selector is required for browser.type', 400);
      if (typeof input.value !== 'string') {
        throw new OpenChamberControlError('value is required for browser.type', 400);
      }
      parameters.selector = selector;
      parameters.value = input.value;
      parameters.submit = input.submit === true;
    }

    if (action === 'browser.scroll') {
      const selector = asNonEmptyString(input.selector);
      const direction = asNonEmptyString(input.direction);
      if (!selector && !direction) {
        throw new OpenChamberControlError('browser.scroll requires direction or selector', 400);
      }
      if (direction && !['up', 'down', 'top', 'bottom'].includes(direction)) {
        throw new OpenChamberControlError('direction must be up, down, top, or bottom', 400);
      }
      if (selector) parameters.selector = selector;
      if (direction) parameters.direction = direction;
    }

    // Opening a page waits for the navigation to settle, so its budget has to
    // exceed the client's own wait; sharing one timeout with the quick actions
    // made a slow page indistinguishable from an unreachable browser.
    const timeoutMs = action === 'browser.open' ? 45_000 : 20_000;
    // Where the call came from, for a provider that keeps one browser per
    // project or chat. Filled by the tool plugin, never by the model.
    const context = {
      directory: asNonEmptyString(contextDirectory),
      sessionId: asNonEmptyString(contextSessionId),
    };
    const result = await browserControl.request(action, parameters, { signal, timeoutMs, context });

    // The image is written here rather than in the renderer: the file belongs
    // beside the code it documents, and the client that took it may be on a
    // different machine than the repository.
    if (action === 'browser.capture') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) {
        throw new OpenChamberControlError('directory is required to save a screenshot', 400);
      }
      const capture = result && typeof result === 'object' ? result : {};
      const saved = await writeScreenshot({
        directory,
        base64: capture.base64,
        mime: capture.mime,
        label: input.label,
      });
      // The base64 never goes back to the caller: it is large, and the path is
      // what an answer, a commit, or a review can actually use.
      return {
        path: saved.path,
        // Saving the file is only half of showing it. Chat collects the image
        // paths written in a finished answer and renders them below it, so the
        // agent is told the one thing it cannot infer: that writing the path is
        // what puts the picture in front of the user.
        hint: `Write ![](${saved.path}) in your reply to show this image to the user; it is rendered under your message.`,
        url: capture.url ?? null,
        title: capture.title ?? null,
        viewport: capture.viewport ?? null,
        width: capture.width ?? null,
        height: capture.height ?? null,
      };
    }

    return result;
  };

  const execute = async (action, input = {}, contextDirectory, options = {}) => {
    try {
      if (!CONTROL_ACTIONS.has(action)) {
        throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
      }
      if (action.startsWith('memory.')) {
        if (!agentMemoryActions) {
          throw new OpenChamberControlError('Agent memory is not available on this server', 503);
        }
        return agentMemoryActions.execute(action, input, contextDirectory);
      }
      if (action.startsWith('browser.')) {
        if (!browserControl) {
          throw new OpenChamberControlError('The in-app browser is not available on this server', 503);
        }
        return browserAction(action, input, options.signal, contextDirectory, options.contextSessionId);
      }
      if (action === 'notify.send') {
        if (!notifyUser) {
          throw new OpenChamberControlError('Notifications are not available on this server', 503);
        }
        const result = await notifyUser({
          title: input.title,
          body: input.body,
          showWhenFocused: input.showWhenFocused,
          sessionId: asNonEmptyString(options.contextSessionId) || undefined,
          directory: asNonEmptyString(contextDirectory) || undefined,
        });
        if (result.status !== 200) {
          throw new OpenChamberControlError(result.body.error, result.status);
        }
        return result.body;
      }
      if (action === 'file.open') {
        if (!fileOpen) {
          throw new OpenChamberControlError('The file viewer is not available on this server', 503);
        }
        return fileOpen.request({
          path: asNonEmptyString(input.path),
          directory: asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory),
          sessionId: asNonEmptyString(options.contextSessionId),
        });
      }
      if (action === 'projects.list') return { projects: await projects() };
      if (action === 'models.list') return models();
      if (action === 'schedule.status') return scheduledTaskService.status();
      if (action.startsWith('schedule.')) {
        const taskID = asNonEmptyString(input.taskId);
        if (SCHEDULE_TASK_ID_ACTIONS.has(action) && !taskID) {
          throw new OpenChamberControlError('taskId is required', 400);
        }
        const explicitProjectID = asNonEmptyString(input.projectId);
        const explicitDirectory = asNonEmptyString(input.directory);
        const contextDirectoryFallback = explicitProjectID
          ? undefined
          : asNonEmptyString(contextDirectory) || undefined;
        const projectID = await scheduledTaskService.resolveProjectID({
          projectId: explicitProjectID || undefined,
          directory: explicitDirectory || contextDirectoryFallback,
        });
        switch (action) {
          case 'schedule.list':
            return { scheduler: await scheduledTaskService.status(), tasks: await scheduledTaskService.list(projectID) };
          case 'schedule.create': {
            const result = await scheduledTaskService.upsert(projectID, buildScheduledTask(input));
            return { task: result.task, created: result.created };
          }
          case 'schedule.run':
            return scheduledTaskService.run(projectID, taskID);
          case 'schedule.delete':
            return { deleted: true, tasks: await scheduledTaskService.remove(projectID, taskID) };
          case 'schedule.toggle': {
            if (typeof input.disabled !== 'boolean') {
              throw new OpenChamberControlError('disabled is required for schedule.toggle', 400);
            }
            const enabled = input.disabled === false;
            return { task: await scheduledTaskService.setEnabled(projectID, taskID, enabled), enabled };
          }
        }
      }
      if (action === 'session.create' || action === 'session.send' || action === 'session.fork') {
        // OMP runs a session where it lives and this seam exposes no create,
        // prompt or fork, so the action answers with the reason instead of
        // pretending a session was created, prompted, or forked.
        throw new OpenChamberControlError(`${action} is not supported on the OMP runtime`, 501);
      }
      if (action.startsWith('session.')) {
        const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
        const sessionID = asNonEmptyString(input.sessionId);
        if (action === 'session.list') {
          const limit = positiveInteger(input.limit, 10, 'limit');
          const known = await readSessions();
          if (!known) throw new OpenChamberControlError('The OMP runtime is not available', 503);
          // Archive is OpenChamber state; overlay it on the runtime's session
          // the way a caller used to read it off the session itself.
          let sessions = (Array.isArray(known) ? known : [])
            .filter((session) => !directory || sameDirectory(session?.cwd, directory))
            .map((session) => {
              const archived = archivedAt(session?.id);
              const listed = {
                id: asNonEmptyString(session?.id) || '',
                directory: asNonEmptyString(session?.cwd) || null,
                title: asNonEmptyString(session?.title) || '',
              };
              return archived ? { ...listed, time: { archived } } : listed;
            });
          if (input.all !== true) sessions = sessions.filter((session) => !session?.time?.archived);
          sessions = sessions.slice(0, limit);
          if (input.withStatus === true) {
            // The runtime reports busy one session at a time; a session whose
            // status cannot be read is unknown, never idle.
            sessions = await Promise.all(sessions.map(async (session) => {
              const status = await readSessionStatus(session.id).catch(() => null);
              return {
                ...session,
                status: status ? asPublicStatus(status.busy === true) : { type: 'unknown' },
              };
            }));
          }
          return { sessions, limit, directory, archived: input.all === true ? 'included' : 'excluded' };
        }
        if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        if (!directory) throw new OpenChamberControlError('directory is required', 400);
        if (action === 'session.status') {
          return { sessionId: sessionID, directory, sessionStatus: await sessionStatus(sessionID) };
        }
        if (action === 'session.messages') {
          if (input.timeout !== undefined && input.wait !== true) throw new OpenChamberControlError('timeout requires wait', 400);
          const role = input.lastAssistant === true ? 'assistant' : (asNonEmptyString(input.role) || 'all');
          if (!['all', 'user', 'assistant'].includes(role)) throw new OpenChamberControlError('role must be all, user, or assistant', 400);
          const last = input.last === true || input.lastAssistant === true;
          if (input.all === true && (last || input.limit !== undefined)) throw new OpenChamberControlError('all cannot be combined with last or limit', 400);
          if (last && input.limit !== undefined) throw new OpenChamberControlError('last cannot be combined with limit', 400);
          const currentStatus = input.wait === true
            ? await waitForIdle({ sessionID, timeoutMs: normalizeWaitTimeoutMs(input.timeout), signal: options.signal })
            : await sessionStatus(sessionID);
          const limit = input.all === true ? undefined : (last ? 1 : positiveInteger(input.limit, 10, 'limit'));
          return { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: await sessionMessages(sessionID, role, limit) };
        }
      }
      throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
    } catch (error) {
      throw asControlError(error, `Failed to execute ${action || 'OpenChamber action'}`);
    }
  };

  // The managed agent-tool plugin cannot report the session's directory (a tool
  // call carries no directory), so it sends the session id and the directory is
  // resolved here, where it is authoritative.
  return { execute, resolveSessionDirectory };
};
