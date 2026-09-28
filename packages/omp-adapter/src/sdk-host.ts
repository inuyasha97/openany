import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent"
import { toOmpSessionInfo } from "./mapping"
import type { OmpHost } from "./runtime"

/**
 * The real OMP host: the SDK binding behind `OmpRuntime`.
 *
 * `openSession` creates a fresh `AgentSession` and, when a session path is
 * given, switches it onto that on-disk session. The handle wraps the SDK
 * session's id, prompt, abort, subscribe, dispose and session file.
 */
export const createOmpHost = (): OmpHost => ({
  listSessions: async () => (await SessionManager.listAll()).map(toOmpSessionInfo),
  openSession: async (input) => {
    const { session } = await createAgentSession(input.cwd ? { cwd: input.cwd } : {})
    if (input.sessionPath) {
      const switched = await session.switchSession(input.sessionPath)
      if (!switched) throw new Error(`omp session switch was cancelled: ${input.sessionPath}`)
    }
    return {
      id: session.sessionId,
      prompt: (text) => session.prompt(text),
      abort: async () => {
        await session.abort()
      },
      subscribe: (listener) => session.subscribe((event) => listener(event)),
      dispose: () => session.dispose(),
      sessionFile: session.sessionFile,
    }
  },
})
