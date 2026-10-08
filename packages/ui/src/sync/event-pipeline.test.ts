/**
 * The event pipeline against the server's WebSocket bridge.
 *
 * Everything the sync layer reduces arrives on `/api/global/event/ws`, already
 * in the canonical vocabulary: the host's own frames (status, archive, metadata,
 * notifications, space lifecycle) and the fork's runtime frames
 * (`openchamber:omp`), which the server projects into `SyncEvent`s before it
 * sends them. The pipeline's job is transport — connect, translate, coalesce
 * per directory, flush in arrival order — so these tests drive it through a
 * scripted stream instead of a real socket.
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test"
import type { RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { GLOBAL_EVENT_DIRECTORY, type SyncEvent } from "@/lib/agent/events"
import { forgetSessionRuntime, registerAgentRuntime, runtimeIdForSession } from "@/lib/agent/registry"
import { createOpenCodeStubRuntime } from "@/lib/agent/testing/opencode-stub-runtime"
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { configureRuntimeUrlResolver } from "@/lib/runtime-url"
import type { Part, Session } from "@/lib/opencode/model"
import type { EventPipeline, SpaceProgress } from "./event-pipeline"

// A frame as the server sends it. `payload` is the wire event or the host's
// own frame; `directory` is the directory the bridge attached.
type Frame = {
  type: "ready" | "event" | "error" | "backpressure"
  replayReset?: boolean
  payload?: unknown
  eventId?: string
  directory?: string
  message?: string
}

type ScriptedStream = {
  socket: RelayTunnelWebSocket
  /** Queues one frame; the stream hands it to the socket in arrival order. */
  push: (frame: Frame) => void
}

/**
 * The stream double: frames are yielded by an async generator that ends when
 * the pipeline tears the socket down, exactly as a real socket's reader does
 * when its attempt is aborted. The pipeline's own `onopen`/`onmessage` handlers
 * are what the double calls, so no delivery path is replaced.
 */
const createScriptedStream = (): ScriptedStream => {
  const pending: Frame[] = []
  let wake: (() => void) | null = null
  let closed = false
  const controller = new AbortController()

  const socket: RelayTunnelWebSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => {
      closed = true
      controller.abort()
      wake?.()
    },
  }

  const frames = async function* (signal: AbortSignal): AsyncGenerator<Frame> {
    while (!signal.aborted) {
      const frame = pending.shift()
      if (frame === undefined) {
        const waiting = Promise.withResolvers<void>()
        wake = waiting.resolve
        signal.addEventListener("abort", () => waiting.resolve(), { once: true })
        await waiting.promise
        wake = null
        continue
      }
      yield frame
    }
  }

  void (async () => {
    socket.onopen?.()
    for await (const frame of frames(controller.signal)) {
      if (closed) return
      socket.onmessage?.({ data: JSON.stringify(frame) })
      // One microtask per frame: the pipeline's own delivery stays synchronous,
      // so a test that queues several frames in one turn sees them in one flush.
      await Promise.resolve()
    }
  })()

  return {
    socket,
    push: (frame) => {
      pending.push(frame)
      wake?.()
    },
  }
}

const streams: ScriptedStream[] = []
const pipelines: EventPipeline[] = []

mock.module("@/lib/relay/runtime-socket", () => ({
  openRuntimeWebSocket: () => {
    const stream = createScriptedStream()
    streams.push(stream)
    return stream.socket
  },
}))

// The mock has to be registered before the pipeline module is evaluated, so a
// static import cannot work here.
const { createEventPipeline } = await import("./event-pipeline")

/**
 * Lets the pipeline's own microtasks run (connect, then one frame per turn)
 * without advancing the clock. Its flush timer is driven by `jest`, below.
 */
const until = async (predicate: () => boolean): Promise<boolean> => {
  for (let tick = 0; tick < 50; tick += 1) {
    if (predicate()) return true
    await Promise.resolve()
  }
  return predicate()
}

/** Delivers queued frames, runs the pipeline's flush timer, then settles. */
const flush = async (): Promise<void> => {
  await until(() => false)
  jest.advanceTimersByTime(1_000)
  await until(() => false)
}

const makeSession = (id: string): Session => ({
  id,
  projectID: "project",
  directory: "/repo/a",
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const textPart = (id: string, messageID: string, text: string): Part => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text,
})

const delta = (value: string): SyncEvent => ({
  type: "message.part.delta",
  properties: { sessionID: "ses_1", messageID: "msg_1", partID: "msg_1:text:0", field: "text", delta: value },
})

/** One projected batch from the fork's runtime, as the server sends it. */
const runtimeFrame = (events: SyncEvent[], directory?: string): Frame => ({
  type: "event",
  payload: { type: "openchamber:omp", properties: { sessionID: "ses_1", directory, events } },
})

type Harness = {
  stream: ScriptedStream
  batches: Array<{ directory: string; events: SyncEvent[] }>
  reconnects: Array<{ replayReset: boolean }>
  disconnects: string[]
  spaceStreams: Array<{ spaceId: string; status: "connected" | "disconnected"; wasReady: boolean }>
  spaceProgress: SpaceProgress[]
  spaceSetup: string[]
}

/** Mounts one pipeline against a scripted stream and waits for it to connect. */
const startPipeline = async (): Promise<Harness> => {
  const harness: Harness = {
    stream: { socket: undefined as unknown as RelayTunnelWebSocket, push: () => undefined },
    batches: [],
    reconnects: [],
    disconnects: [],
    spaceStreams: [],
    spaceProgress: [],
    spaceSetup: [],
  }
  const pipeline = createEventPipeline({
    onEvents: (directory, events) => harness.batches.push({ directory, events: [...events] }),
    onReconnect: (details) => harness.reconnects.push(details),
    onDisconnect: (reason) => harness.disconnects.push(reason),
    onSpaceStream: (details) => harness.spaceStreams.push(details),
    onSpaceProgress: (details) => harness.spaceProgress.push(details),
    onSpaceSetup: (spaceId) => harness.spaceSetup.push(spaceId),
  })
  pipelines.push(pipeline)
  await until(() => streams.length > 0)
  harness.stream = streams[streams.length - 1]
  harness.stream.push({ type: "ready" })
  await until(() => harness.reconnects.length > 0)
  return harness
}

beforeEach(() => {
  jest.useFakeTimers()
  streams.length = 0
  pipelines.length = 0
  // The socket upgrade authenticates with the url token; the pipeline mints one
  // before it connects. A valid token keeps that off the network.
  setRuntimeUrlAuthToken("test-url-token", Date.now() + 60_000)
  configureRuntimeUrlResolver({ apiBaseUrl: "https://runtime.test" })
})

afterEach(() => {
  for (const pipeline of pipelines) pipeline.cleanup()
  clearRuntimeUrlAuthToken()
  jest.useRealTimers()
})

describe("event pipeline", () => {
  test("delivers an openchamber:omp frame to the directory it names, in order", async () => {
    const harness = await startPipeline()

    // The frame's own directory wins over the one the bridge attached.
    harness.stream.push({
      type: "event",
      directory: "/repo/attached",
      eventId: "evt_1",
      payload: {
        type: "openchamber:omp",
        properties: {
          sessionID: "ses_1",
          directory: "/repo/a",
          events: [
            { type: "message.patched", properties: { sessionID: "ses_1", messageID: "msg_1", patch: { time: { created: 5 } } } },
            { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("msg_1:text:0", "msg_1", "hello") } },
            delta(" world"),
          ],
        },
      },
    })
    await flush()

    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0].directory).toBe("/repo/a")
    expect(harness.batches[0].events.map((event) => event.type)).toEqual([
      "message.patched",
      "message.part.updated",
      "message.part.delta",
    ])
    expect(harness.disconnects).toEqual([])
  })

  test("falls back to the bridge's directory, then to the global queue", async () => {
    const harness = await startPipeline()

    harness.stream.push({
      type: "event",
      directory: "/repo/b",
      payload: {
        type: "openchamber:omp",
        properties: { sessionID: "ses_1", events: [{ type: "session.idle", properties: { sessionID: "ses_1" } }] },
      },
    })
    await flush()
    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0].directory).toBe("/repo/b")

    harness.stream.push({
      type: "event",
      payload: {
        type: "openchamber:omp",
        properties: { sessionID: "ses_2", events: [{ type: "session.idle", properties: { sessionID: "ses_2" } }] },
      },
    })
    await flush()
    expect(harness.batches).toHaveLength(2)
    expect(harness.batches[1].directory).toBe(GLOBAL_EVENT_DIRECTORY)
    expect(harness.batches[1].events.map((event) => event.type)).toEqual(["session.idle"])
  })

  test("registers the runtime a created session came from", async () => {
    const harness = await startPipeline()
    registerAgentRuntime(createOpenCodeStubRuntime("alt"))
    expect(runtimeIdForSession("ses_child")).toBe("omp")

    // SAFETY: the server's `session.created` carries the owning runtime id on
    // the info record; the canonical `Session` type does not declare it.
    const childInfo = { ...makeSession("ses_child"), runtimeId: "alt" } as Session

    try {
      harness.stream.push(
        runtimeFrame(
          [{ type: "session.created", properties: { info: childInfo } }],
          "/repo/a",
        ),
      )
      await flush()

      expect(runtimeIdForSession("ses_child")).toBe("alt")
    } finally {
      forgetSessionRuntime("ses_child")
    }
  })

  test("coalesces repeated deltas into one growth and lets a snapshot end the window", async () => {
    const harness = await startPipeline()

    harness.stream.push(runtimeFrame([delta("Hel"), delta("lo")], "/repo/a"))
    await flush()

    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0].events).toHaveLength(1)
    const [first] = harness.batches[0].events
    if (first?.type !== "message.part.delta") throw new Error("expected one coalesced delta")
    expect(first.properties.delta).toBe("Hello")

    // A full part snapshot is a barrier for that part: a delta queued before it
    // stays before it, and a delta after it is delivered after it rather than
    // merged into the earlier one.
    harness.stream.push(runtimeFrame([
      delta("!"),
      { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("msg_1:text:0", "msg_1", "Hello!") } },
      delta("?"),
    ], "/repo/a"))
    await flush()

    expect(harness.batches).toHaveLength(2)
    expect(harness.batches[1].events.map((event) => event.type)).toEqual([
      "message.part.delta",
      "message.part.updated",
      "message.part.delta",
    ])
  })

  test("hands the host's space frames to their owner instead of a directory queue", async () => {
    const harness = await startPipeline()
    const spaceId = "abcdef012345"

    harness.stream.push({
      type: "event",
      payload: { type: "openchamber:space-stream", properties: { spaceId, status: "disconnected", wasReady: true } },
    })
    harness.stream.push({
      type: "event",
      payload: {
        type: "openchamber:space-progress",
        properties: { spaceId, step: "failed", failure: { code: "setup_failed", message: "bun install failed" } },
      },
    })
    harness.stream.push({
      type: "event",
      payload: { type: "openchamber:space-setup", properties: { spaceId } },
    })
    await flush()

    expect(harness.spaceStreams).toEqual([{ spaceId, status: "disconnected", wasReady: true }])
    expect(harness.spaceProgress).toEqual([
      { spaceId, step: "failed", failure: { code: "setup_failed", message: "bun install failed" } },
    ])
    expect(harness.spaceSetup).toEqual([spaceId])

    // A space frame is not a session event: it never reaches a directory queue.
    expect(harness.batches).toEqual([])
  })
})
