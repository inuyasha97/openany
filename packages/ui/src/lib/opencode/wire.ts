/**
 * The v2 wire contract, declared locally.
 *
 * Everything the server encodes — HTTP payloads and WebSocket event frames —
 * is described by these shapes. OpenChamber used to take them from the
 * generated OpenCode client package; the fork no longer depends on that
 * package, so the contract the adapter layer decodes is declared here. Only
 * `model.ts` (the domain model), `projection.ts` (wire → domain) and
 * `events.ts` (wire event → sync vocabulary) read from this file.
 *
 * Copied field for field from the v2 contract, including optionality, so a
 * decoding bug here still shows up as a projection bug rather than a silent
 * mistranslation. Regenerate against the contract when the server's schema
 * moves; never hand-edit.
 */

export type JsonValue = null | boolean | number | string | Array<JsonValue> | {
  [key: string]: JsonValue;
};

export type LocationPublicRef = {
  directory: string;
};

export type ModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export type ProviderCompaction = {
  type: "summary";
} | {
  type: "native";
};

export type ProviderTransport = "http" | "websocket";

export type AgentColor = string;

export type PermissionEffect = "allow" | "deny" | "ask";

export type SessionForkBoundary = {
  type: "before";
  messageID: string;
} | {
  type: "through";
  messageID: string;
};

export type MoneyUSD = number;

export type TokenUsageInfo = {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
};

export type SessionMetadata = {
  [x: string]: JsonValue;
};

export type FileDiffInfo = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
};

export type SessionMessageAgentSelected = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "agent-switched";
  agent: string;
  previous?: string;
};

export type PromptBase64 = string;

export type PromptFileSource = {
  type: "inline";
} | {
  type: "uri";
  uri: string;
};

export type PromptMention = {
  start: number;
  end: number;
  text: string;
};

export type SessionMessageSynthetic = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  text: string;
  description?: string;
  type: "synthetic";
};

export type SessionMessageSystem = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "system";
  text: string;
  description?: string;
};

export type SessionMessageSkill = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "skill";
  skill: string;
  name: string;
  text: string;
};

export type SessionMessageShell = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
    completed?: number;
  };
  type: "shell";
  shellID: string;
  command: string;
  status: "running" | "exited" | "timeout" | "killed";
  exit?: number | "Infinity" | "-Infinity" | "NaN";
  output?: {
    output: string;
    cursor: number;
    size: number;
    truncated: boolean;
  };
};

export type SessionMessageProviderState = {
  [x: string]: JsonValue;
};

export type SessionMessageToolStateStreaming = {
  status: "streaming";
  input: string;
};

export type SessionMessageToolStateRunning = {
  status: "running";
  input: {
    [x: string]: JsonValue;
  };
  metadata: {
    [x: string]: JsonValue;
  };
};

export type ToolTextContent = {
  type: "text";
  text: string;
};

export type ToolFileContent = {
  type: "file";
  uri: string;
  mime: string;
  name?: string | null;
};

export type SessionStructuredError = {
  type: string;
  message: string;
  status?: number;
};

export type SessionMessageCompactionRunning = {
  type: "compaction";
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  status: "running";
  reason: "auto" | "manual";
  summary: string;
  recent: string;
};

export type SessionProviderContextProvenance = {
  providerID: string;
  provider: string;
  modelID: string;
  route: string;
  protocol: string;
  endpoint: string;
};

export type SessionMessageIdle = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "idle";
  outcome: "succeeded" | "failed" | "interrupted";
};

export type SessionInboxDelivery = "steer" | "queue";

export type SessionInboxCompactionPayload = {};

export type InstructionEntryKey = string;

export type LocationRef = {
  directory: string;
  workspaceID?: string;
};

export type SessionInboxSyntheticPayload1 = {
  text: string;
  description?: string;
  metadata?: {
    [x: string]: any;
  };
};

export type ShellInfo = {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  cwd: string;
  shell: string;
  file: string;
  pid?: number;
  exit?: number;
  signal?: string;
  metadata: {
    [x: string]: any;
  };
  time: {
    started: number;
    completed?: number;
  };
};

export type SessionMessageProviderState1 = {
  [x: string]: any;
};

export type ToolFileContent1 = {
  type: "file";
  uri: string;
  mime: string;
  name?: string | undefined;
};

export type FormMetadata = {
  [x: string]: JsonValue;
};

export type FormWhen = {
  key: string;
  op: "eq" | "neq";
  value: string | number | "Infinity" | "-Infinity" | "NaN" | boolean;
};

export type FormOption = {
  value: string;
  label: string;
  description?: string;
};

export type FormExternalField = {
  key: string;
  type: "external";
  url: string;
  title?: string;
  description?: string;
};

export type FormValue = string | number | "Infinity" | "-Infinity" | "NaN" | boolean | Array<string>;

export type ModelReasoningField = "reasoning" | "reasoning_content" | "reasoning_text" | (string & {});

export type ModelMaxTokensField = "max_completion_tokens" | "max_tokens";

export type ModelCapabilities = {
  tools: boolean;
  input: Array<string>;
  output: Array<string>;
};

export type MoneyUSDPerMillionTokens = number;

export type McpStatusConnected = {
  status: "connected";
};

export type McpStatusPending = {
  status: "pending";
};

export type McpStatusDisabled = {
  status: "disabled";
};

export type McpStatusFailed = {
  status: "failed";
  error: string;
};

export type McpStatusNeedsAuth = {
  status: "needs_auth";
  error: string;
};

export type ProjectVcs = string;

export type ProjectIcon = {
  url?: string;
  override?: string;
  color?: string;
};

export type ProjectCommands = {
  start?: string;
};

export type ProjectTime = {
  created: number;
  updated: number;
  active: number;
};

export type PermissionSource = {
  type: "tool";
  messageID: string;
  id: string;
};

export type CommandInfo = {
  name: string;
  description?: string;
};

export type SkillInfo = {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
};

export type PermissionReply = "once" | "always" | "reject";

export type Pty = {
  id: string;
  title: string;
  command: string;
  args: Array<string>;
  cwd: string;
  status: "running" | "exited";
  pid: number;
  exitCode?: number;
};

export type PersistentPtyInfo = {
  id: string;
  title: string;
  command: string;
  args: Array<string>;
  cwd: string;
  status: "running" | "exited";
  pid: number;
  exitCode?: number;
  sessionID: string;
  foregroundProcess: string | null;
  size: {
    cols: number;
    rows: number;
  };
  output: {
    head: number;
    tail: number;
  };
};

export type FormMetadata1 = {
  [x: string]: any;
};

export type FormWhen1 = {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
};

export type FormValue1 = string | number | boolean | Array<string>;

export type SessionStatus = {
  type: "idle";
} | {
  type: "retry";
  attempt: number;
  message: string;
  action?: {
    reason: string;
    provider: string;
    title: string;
    message: string;
    label: string;
    link?: string;
  };
  next: number;
} | {
  type: "busy";
};

export type VcsBranch = {
  current?: string;
  default?: string;
};

export type McpProtocol = "legacy" | "auto" | "2026-07-28";

export type ConfigWorktree = {
  directory: string;
};

export type SessionMessageLocationSwitched = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "location-switched";
  projectID?: string;
  subpath?: string;
  location: LocationPublicRef;
  previous?: {
    location: LocationPublicRef;
    projectID?: string;
    subpath?: string;
  } | null;
};

export type V2EventRpc = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  } | undefined;
  type: `${"rpc."}${string}`;
  location: LocationPublicRef;
  data: {
    [x: string]: any;
  };
};

export type V2EventServerConnected = {
  id: string;
  metadata?: {
    [x: string]: any;
  } | undefined;
  location?: LocationPublicRef | undefined;
  type: "server.connected";
  data: {};
};

export type ModelSettings = {
  compaction?: ProviderCompaction;
} & {
  [x: string]: any;
};

export type ConfigModelSettings = {
  compaction?: ProviderCompaction;
} & {
  [x: string]: JsonValue | null;
};

export type ProviderSettings = {
  timeout?: number | false;
  chunkTimeout?: number;
  compaction?: ProviderCompaction;
  transport?: ProviderTransport;
} & {
  [x: string]: any;
};

export type ConfigProviderSettings = {
  timeout?: number | false;
  chunkTimeout?: number;
  compaction?: ProviderCompaction;
  transport?: ProviderTransport;
} & {
  [x: string]: JsonValue | null;
};

export type PermissionRule = {
  action: string;
  resource: string;
  effect: PermissionEffect;
};

export type SessionRevert = {
  messageID: string;
  partID?: string;
  snapshot?: string;
  files?: Array<FileDiffInfo>;
};

export type SessionMessageModelSelected = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  type: "model-switched";
  model: ModelRef;
  previous?: ModelRef;
};

export type PromptFileAttachment = {
  data: PromptBase64;
  mime: string;
  source: PromptFileSource;
  name?: string;
  description?: string;
  mention?: PromptMention;
};

export type PromptAgentAttachment = {
  name: string;
  mention?: PromptMention;
};

export type PromptSkillAttachment = {
  id: string;
  name: string;
  text?: string;
  mention?: PromptMention;
};

export type SessionMessageAssistantText = {
  type: "text";
  text: string;
  state?: SessionMessageProviderState;
};

export type SessionMessageAssistantReasoning = {
  type: "reasoning";
  text: string;
  state?: SessionMessageProviderState;
  time?: {
    created: number;
    completed?: number;
  };
};

export type ToolContent = ToolTextContent | ToolFileContent;

export type SessionMessageAssistantRetry = {
  attempt: number;
  at: number;
  error: SessionStructuredError;
};

export type SessionMessageCompactionFailed = {
  type: "compaction";
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  status: "failed";
  reason: "auto" | "manual";
  error: SessionStructuredError;
  cost?: MoneyUSD;
  tokens?: TokenUsageInfo;
};

export type SessionProviderContext = {
  version: 1;
  provenance: SessionProviderContextProvenance;
  messages: JsonValue;
};

export type InstructionEntrySnapshot = Array<{
  key: InstructionEntryKey;
  value: JsonValue;
  removed: boolean;
}>;

export type SessionAgentSelected = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.agent.selected";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    agent: string;
    previous?: string;
  };
};

export type SessionModelSelected = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.model.selected";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    model: ModelRef;
    previous?: ModelRef;
  };
};

export type SessionRenamed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.renamed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    title: string;
  };
};

export type SessionViewed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.viewed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    idle: number;
  };
};

export type SessionDeleted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.deleted";
  durable: {
    aggregateID: string;
    seq: number;
    version: 2;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type SessionInboxDelivered = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.inbox.delivered";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    inboxID: string;
  };
};

export type SessionInboxCancelled = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.inbox.cancelled";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    inboxID: string;
  };
};

export type SessionInboxDeliveryChanged = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.inbox.delivery.changed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    inboxID: string;
    delivery: SessionInboxDelivery;
  };
};

export type SessionExecutionStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.execution.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type SessionExecutionSucceeded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.execution.succeeded";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type SessionExecutionFailed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.execution.failed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    error: SessionStructuredError;
  };
};

export type SessionExecutionInterrupted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.execution.interrupted";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    reason: "user" | "shutdown" | "superseded" | "inactivity";
  };
};

export type SessionInstructionsUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.instructions.updated";
  durable: {
    aggregateID: string;
    seq: number;
    version: 2;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    delta: {
      [x: string]: string | "removed";
    };
    text?: string;
  };
};

export type SessionSynthetic = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.synthetic";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    text: string;
    description?: string;
    metadata?: {
      [x: string]: any;
    };
  };
};

export type SessionSkillActivated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.skill.activated";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    id: string;
    name: string;
    text: string;
  };
};

export type SessionStepStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.step.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    agent: string;
    model: ModelRef;
    snapshot?: string;
    started: number;
  };
};

export type SessionStepStreamed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.step.streamed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
  };
};

export type SessionTextStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.text.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
  };
};

export type SessionToolInputStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.input.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    name: string;
  };
};

export type SessionToolInputEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.input.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    text: string;
  };
};

export type SessionRetryScheduled = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.retry.scheduled";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    attempt: number;
    at: number;
    error: SessionStructuredError;
  };
};

export type SessionCompactionStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.compaction.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    reason: "auto" | "manual";
    recent: string;
    inputID?: string;
  };
};

export type SessionCompactionFailed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.compaction.failed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    reason: "auto" | "manual";
    error: SessionStructuredError;
    inputID?: string;
    cost?: MoneyUSD;
    tokens?: TokenUsageInfo;
  };
};

export type SessionRevertCleared = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.revert.cleared";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type SessionRevertCommitted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.revert.committed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    to: string;
  };
};

export type LocationShutdown = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "location.shutdown";
  location?: LocationRef;
  data: {};
};

export type ModelsDevRefreshed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "models-dev.refreshed";
  location?: LocationRef;
  data: {};
};

export type CredentialUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "credential.updated";
  location?: LocationRef;
  data: {};
};

export type CredentialSwitched = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "credential.switched";
  location?: LocationRef;
  data: {
    integrationID: string;
    credentialID: string | null;
  };
};

export type IntegrationUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "integration.updated";
  location?: LocationRef;
  data: {};
};

export type ProviderUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "provider.updated";
  location?: LocationRef;
  data: {};
};

export type ModelUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "model.updated";
  location?: LocationRef;
  data: {};
};

export type AgentUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "agent.updated";
  location?: LocationRef;
  data: {};
};

export type SessionUsageUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.usage.updated";
  location?: LocationRef;
  data: {
    sessionID: string;
    cost: MoneyUSD;
    tokens: TokenUsageInfo;
  };
};

export type SessionTextDelta = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.text.delta";
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    delta: string;
  };
};

export type SessionReasoningDelta = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.reasoning.delta";
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    delta: string;
  };
};

export type SessionToolInputDelta = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.input.delta";
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    delta: string;
  };
};

export type SessionToolProgress = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.progress";
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    metadata: {
      [x: string]: JsonValue;
    };
  };
};

export type SessionCompactionDelta = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.compaction.delta";
  location?: LocationRef;
  data: {
    sessionID: string;
    text: string;
  };
};

export type FilesystemChanged = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "filesystem.changed";
  location?: LocationRef;
  data: {
    file: string;
    event: "add" | "change" | "unlink";
  };
};

export type ReferenceUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "reference.updated";
  location?: LocationRef;
  data: {};
};

export type PluginUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "plugin.updated";
  location?: LocationRef;
  data: {};
};

export type WorktreeUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "worktree.updated";
  location?: LocationRef;
  data: {
    projectID: string;
  };
};

export type WorktreeResolved = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "worktree.resolved";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    projectID: string;
    directory: string;
    previous: string;
    adopted?: Array<string>;
  };
};

export type CommandUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "command.updated";
  location?: LocationRef;
  data: {};
};

export type ConfigUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "config.updated";
  location?: LocationRef;
  data: {};
};

export type SkillUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "skill.updated";
  location?: LocationRef;
  data: {};
};

export type PtyExited = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "pty.exited";
  location?: LocationRef;
  data: {
    id: string;
    exitCode: number;
  };
};

export type PtyDeleted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "pty.deleted";
  location?: LocationRef;
  data: {
    id: string;
  };
};

export type PersistentPtyRemoved = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "persistent-pty.removed";
  location?: LocationRef;
  data: {
    sessionID: string;
    ptyID: string;
  };
};

export type ShellExited = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "shell.exited";
  location?: LocationRef;
  data: {
    id: string;
    exit?: number;
    status: "running" | "exited" | "timeout" | "killed";
  };
};

export type ShellDeleted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "shell.deleted";
  location?: LocationRef;
  data: {
    id: string;
  };
};

export type FormCancelled = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "form.cancelled";
  location?: LocationRef;
  data: {
    id: string;
    sessionID: string;
  };
};

export type WebsearchUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "websearch.updated";
  location?: LocationRef;
  data: {};
};

export type SessionIdle = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.idle";
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type TuiPromptAppend = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "tui.prompt.append";
  location?: LocationRef;
  data: {
    text: string;
  };
};

export type TuiCommandExecute = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "tui.command.execute";
  location?: LocationRef;
  data: {
    command: "session.list" | "session.new" | "session.share" | "session.interrupt" | "session.background" | "session.compact" | "session.page.up" | "session.page.down" | "session.line.up" | "session.line.down" | "session.half.page.up" | "session.half.page.down" | "session.first" | "session.last" | "prompt.clear" | "prompt.submit" | "agent.cycle" | (string & {});
  };
};

export type TuiToastShow = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "tui.toast.show";
  location?: LocationRef;
  data: {
    title?: string;
    message: string;
    variant: "info" | "success" | "warning" | "error";
    duration?: number | undefined;
  };
};

export type TuiSessionSelect = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "tui.session.select";
  location?: LocationRef;
  data: {
    sessionID: string;
  };
};

export type InstallationUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "installation.updated";
  location?: LocationRef;
  data: {
    version: string;
  };
};

export type InstallationUpdateAvailable = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "installation.update-available";
  location?: LocationRef;
  data: {
    version: string;
  };
};

export type VcsBranchUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "vcs.branch.updated";
  location?: LocationRef;
  data: {
    branch?: string;
  };
};

export type McpStatusChanged = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "mcp.status.changed";
  location?: LocationRef;
  data: {
    server: string;
  };
};

export type McpResourcesChanged = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "mcp.resources.changed";
  location?: LocationRef;
  data: {
    server: string;
  };
};

export type SessionMoved = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.moved";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    location: LocationRef;
    projectID: string;
    subpath?: string;
  };
};

export type SessionInboxMovePayload1 = {
  location: LocationRef;
  projectID: string;
  subpath?: string;
};

export type SessionMetadataUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.metadata.updated";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    metadata: SessionMetadata;
  };
};

export type SessionShellStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.shell.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    shell: ShellInfo;
  };
};

export type SessionShellEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.shell.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    shell: ShellInfo;
    output: {
      output: string;
      cursor: number;
      size: number;
      truncated: boolean;
    };
  };
};

export type ShellCreated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "shell.created";
  location?: LocationRef;
  data: {
    info: ShellInfo;
  };
};

export type SessionStepEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.step.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    finish: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
    rawFinish?: string;
    providerState?: SessionMessageProviderState1;
    cost: MoneyUSD;
    tokens: TokenUsageInfo;
    snapshot?: string;
    files?: Array<string>;
  };
};

export type SessionStepFailed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.step.failed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    error: SessionStructuredError;
    finish?: "content-filter";
    rawFinish?: string;
    providerState?: SessionMessageProviderState1;
    cost?: MoneyUSD;
    tokens?: TokenUsageInfo;
    snapshot?: string;
    files?: Array<string>;
  };
};

export type SessionTextEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.text.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    text: string;
    state?: SessionMessageProviderState1;
  };
};

export type SessionReasoningStarted = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.reasoning.started";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    state?: SessionMessageProviderState1;
  };
};

export type SessionReasoningEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.reasoning.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    text: string;
    state?: SessionMessageProviderState1;
  };
};

export type SessionToolCalled = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.called";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    input: {
      [x: string]: any;
    };
    executed: boolean;
    state?: SessionMessageProviderState1;
  };
};

export type ToolContent1 = ToolTextContent | ToolFileContent1;

export type FormNumberField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen>;
  type: "number";
  minimum?: number | "Infinity" | "-Infinity" | "NaN";
  maximum?: number | "Infinity" | "-Infinity" | "NaN";
  default?: number | "Infinity" | "-Infinity" | "NaN";
};

export type FormIntegerField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen>;
  type: "integer";
  minimum?: number | "Infinity" | "-Infinity" | "NaN";
  maximum?: number | "Infinity" | "-Infinity" | "NaN";
  default?: number | "Infinity" | "-Infinity" | "NaN";
};

export type FormBooleanField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen>;
  type: "boolean";
  default?: boolean;
};

export type FormStringField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen>;
  type: "string";
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  default?: string;
  options?: Array<FormOption>;
  custom?: boolean;
};

export type FormMultiselectField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen>;
  type: "multiselect";
  options: Array<FormOption>;
  minItems?: number;
  maxItems?: number;
  custom?: boolean;
  default?: Array<string>;
};

export type FormAnswer = {
  [x: string]: FormValue;
};

export type ModelCompatibility = {
  reasoningField?: ModelReasoningField;
  requireReasoning?: boolean;
  maxTokensField?: ModelMaxTokensField;
  requireFinishReason?: boolean;
  requireAssistantAfterTool?: boolean;
  supportsPromptCacheKey?: boolean;
};

export type ModelCost = {
  tier?: {
    type: "context";
    size: number;
  };
  input: MoneyUSDPerMillionTokens;
  output: MoneyUSDPerMillionTokens;
  cache: {
    read: MoneyUSDPerMillionTokens;
    write: MoneyUSDPerMillionTokens;
  };
};

export type McpServer = {
  name: string;
  status: McpStatusConnected | McpStatusPending | McpStatusDisabled | McpStatusFailed | McpStatusNeedsAuth;
  integrationID?: string;
};

export type Project = {
  id: string;
  canonical: string;
  vcs?: ProjectVcs;
  name?: string;
  icon?: ProjectIcon;
  commands?: ProjectCommands;
  time: ProjectTime;
  sandboxes: Array<string>;
};

export type ProjectUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "project.updated";
  location?: LocationRef;
  data: {
    id: string;
    canonical: string;
    vcs?: ProjectVcs;
    name?: string;
    icon?: ProjectIcon;
    commands?: ProjectCommands;
    time: ProjectTime;
    sandboxes: Array<string>;
  };
};

export type PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: Array<string>;
  save?: Array<string>;
  metadata?: {
    [x: string]: JsonValue;
  };
  source?: PermissionSource;
  message?: string;
};

export type PermissionAsked = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "permission.asked";
  location?: LocationRef;
  data: {
    id: string;
    sessionID: string;
    action: string;
    resources: Array<string>;
    save?: Array<string>;
    metadata?: {
      [x: string]: any;
    };
    source?: PermissionSource;
    message?: string;
  };
};

export type PermissionReplied = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "permission.replied";
  location?: LocationRef;
  data: {
    sessionID: string;
    requestID: string;
    reply: PermissionReply;
  };
};

export type PtyCreated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "pty.created";
  location?: LocationRef;
  data: {
    info: Pty;
  };
};

export type PtyUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "pty.updated";
  location?: LocationRef;
  data: {
    info: Pty;
  };
};

export type PersistentPtyAdded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "persistent-pty.added";
  location?: LocationRef;
  data: {
    sessionID: string;
    terminal: PersistentPtyInfo;
  };
};

export type FormStringField1 = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen1>;
  type: "string";
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  default?: string;
  options?: Array<FormOption>;
  custom?: boolean;
};

export type FormNumberField1 = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen1>;
  type: "number";
  minimum?: number;
  maximum?: number;
  default?: number;
};

export type FormIntegerField1 = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen1>;
  type: "integer";
  minimum?: number;
  maximum?: number;
  default?: number;
};

export type FormBooleanField1 = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen1>;
  type: "boolean";
  default?: boolean;
};

export type FormMultiselectField1 = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<FormWhen1>;
  type: "multiselect";
  options: Array<FormOption>;
  minItems?: number;
  maxItems?: number;
  custom?: boolean;
  default?: Array<string>;
};

export type FormAnswer1 = {
  [x: string]: FormValue1;
};

export type SessionStatusUpdated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.status";
  location?: LocationRef;
  data: {
    sessionID: string;
    status: SessionStatus;
  };
};

export type VcsInfo = {
  provider?: string;
  branch: VcsBranch;
};

export type ModelVariant = {
  id: string;
  settings?: ModelSettings;
  headers?: {
    [x: string]: string;
  };
  body?: {
    [x: string]: any;
  };
};

export type ProviderRequest = {
  settings: ProviderSettings;
  headers: {
    [x: string]: string;
  };
  body: {
    [x: string]: any;
  };
};

export type ProviderInfo = {
  id: string;
  canonical?: string;
  integrationID?: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  package: string;
  settings?: ProviderSettings;
  headers?: {
    [x: string]: string;
  };
  body?: {
    [x: string]: any;
  };
};

export type PermissionRuleset = Array<PermissionRule>;

export type SessionRevertStaged = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.revert.staged";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    revert: SessionRevert;
  };
};

export type SessionMessageUser = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  text: string;
  files?: Array<PromptFileAttachment>;
  agents?: Array<PromptAgentAttachment>;
  skills?: Array<PromptSkillAttachment>;
  type: "user";
};

export type SessionInboxUserPayload = {
  text: string;
  files?: Array<PromptFileAttachment>;
  agents?: Array<PromptAgentAttachment>;
  skills?: Array<PromptSkillAttachment>;
  metadata?: {
    [x: string]: JsonValue;
  };
};

export type SessionInboxUserPayload1 = {
  text: string;
  files?: Array<PromptFileAttachment>;
  agents?: Array<PromptAgentAttachment>;
  skills?: Array<PromptSkillAttachment>;
  metadata?: {
    [x: string]: any;
  };
};

export type SessionMessageToolStateCompleted = {
  status: "completed";
  input: {
    [x: string]: JsonValue;
  };
  content: [ToolContent, ...Array<ToolContent>];
  metadata?: {
    [x: string]: JsonValue;
  };
};

export type SessionMessageToolStateError = {
  status: "error";
  input: {
    [x: string]: JsonValue;
  };
  error: SessionStructuredError;
  content?: [ToolContent, ...Array<ToolContent>];
  metadata?: {
    [x: string]: JsonValue;
  };
};

export type SessionMessageCompactionCompleted = {
  type: "compaction";
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
  };
  status: "completed";
  reason: "auto" | "manual";
  model?: ModelRef;
  providerState?: SessionMessageProviderState;
  summary: string;
  recent: string;
  providerContext?: SessionProviderContext;
  cost?: MoneyUSD;
  tokens?: TokenUsageInfo;
};

export type SessionCompactionEnded = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.compaction.ended";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    reason: "auto" | "manual";
    model?: ModelRef;
    providerState?: SessionMessageProviderState1;
    providerContext?: SessionProviderContext;
    text: string;
    recent: string;
    cost?: MoneyUSD;
    tokens?: TokenUsageInfo;
  };
};

export type SessionForked = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.forked";
  durable: {
    aggregateID: string;
    seq: number;
    version: 2;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    parentID: string;
    boundary: SessionForkBoundary;
    instructions?: {
      [x: string]: string;
    };
    instructionEntries?: InstructionEntrySnapshot;
  };
};

export type SessionToolSuccess = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.success";
  durable: {
    aggregateID: string;
    seq: number;
    version: 2;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    content: [ToolContent1, ...Array<ToolContent1>];
    metadata?: {
      [x: string]: JsonValue;
    };
    executed: boolean;
    resultState?: SessionMessageProviderState1;
  };
};

export type SessionToolFailed = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.tool.failed";
  durable: {
    aggregateID: string;
    seq: number;
    version: 2;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    assistantMessageID: string;
    id: string;
    error: SessionStructuredError;
    content?: [ToolContent1, ...Array<ToolContent1>];
    metadata?: {
      [x: string]: JsonValue;
    };
    executed: boolean;
    resultState?: SessionMessageProviderState1;
  };
};

export type FormField = FormStringField | FormNumberField | FormIntegerField | FormBooleanField | FormMultiselectField | FormExternalField;

export type FormField1 = FormStringField1 | FormNumberField1 | FormIntegerField1 | FormBooleanField1 | FormMultiselectField1 | FormExternalField;

export type FormReplied = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "form.replied";
  location?: LocationRef;
  data: {
    id: string;
    sessionID: string;
    answer: FormAnswer1;
  };
};

export type ModelInfo = {
  id: string;
  modelID: string;
  providerID: string;
  canonical?: string;
  family?: string;
  name: string;
  compatibility?: ModelCompatibility;
  package?: string;
  settings?: ModelSettings;
  headers?: {
    [x: string]: string;
  };
  body?: {
    [x: string]: any;
  };
  capabilities: ModelCapabilities;
  variants: Array<ModelVariant>;
  time: {
    released: number;
  };
  cost: Array<ModelCost>;
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  limit: {
    context: number;
    input?: number;
    output: number;
  };
};

export type AgentInfo = {
  id: string;
  name: string;
  model?: ModelRef;
  request: ProviderRequest;
  system?: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  color?: AgentColor;
  steps?: number;
  permissions: PermissionRuleset;
};

export type SessionPermissions = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.permissions";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    permissions: PermissionRuleset;
  };
};

export type SessionInfo = {
  id: string;
  parentID?: string;
  fork?: {
    sessionID: string;
    boundary: SessionForkBoundary;
  };
  projectID: string;
  agent?: string;
  model?: ModelRef;
  cost: MoneyUSD;
  tokens: TokenUsageInfo;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: {
    created: number;
    updated: number;
    idle?: number;
    viewed?: number;
    archived?: number;
  };
  title?: string;
  subpath?: string;
  metadata?: SessionMetadata;
  permissions?: PermissionRuleset;
  revert?: SessionRevert;
  location: LocationPublicRef;
};

export type SessionCreated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.created";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    projectID: string;
    location: LocationRef;
    subpath?: string;
    parentID?: string;
    slug: string;
    title?: string;
    agent?: string;
    model?: ModelRef;
    metadata?: SessionMetadata;
    permissions?: PermissionRuleset;
    version: string;
  };
};

export type ConfigEntry = {
  type: "document";
  path?: string;
  info: {
    $schema?: string;
    shell?: string;
    model?: string | {
      providerID: string;
      model: string;
      variant?: string;
    };
    default_agent?: string;
    update?: "disable" | "notify" | "auto";
    share?: "manual" | "auto" | "disabled";
    enterprise?: {
      url?: string;
    };
    username?: string;
    permissions?: PermissionRuleset;
    agents?: {
      [x: string]: {
        model?: string | {
          providerID: string;
          model: string;
          variant?: string;
        };
        request?: {
          headers?: {
            [x: string]: string;
          };
          body?: {
            [x: string]: JsonValue;
          };
        };
        system?: string;
        description?: string;
        mode?: "subagent" | "primary" | "all";
        hidden?: boolean;
        color?: string;
        steps?: number;
        disabled?: boolean;
        permissions?: PermissionRuleset;
      };
    };
    snapshots?: boolean;
    watcher?: {
      ignore?: Array<string>;
    };
    formatter?: boolean | {
      [x: string]: {
        disabled?: boolean;
        command?: Array<string>;
        environment?: {
          [x: string]: string;
        };
        extensions?: Array<string>;
      };
    };
    lsp?: boolean | {
      [x: string]: {
        disabled: true;
      } | {
        command: Array<string>;
        extensions?: Array<string>;
        disabled?: boolean;
        env?: {
          [x: string]: string;
        };
        initialization?: {
          [x: string]: JsonValue;
        };
      };
    };
    media?: {
      image?: {
        auto_resize?: boolean;
        max_width?: number;
        max_height?: number;
        max_base64_bytes?: number;
      };
    };
    tool_output?: {
      max_lines?: number;
      max_bytes?: number;
    };
    mcp?: {
      timeout?: {
        startup?: number;
        catalog?: number;
        execution?: number;
      };
      servers?: {
        [x: string]: {
          type: "local";
          command: Array<string>;
          cwd?: string;
          environment?: {
            [x: string]: string;
          };
          disabled?: boolean;
          codemode?: boolean;
          timeout?: {
            startup?: number;
            catalog?: number;
            execution?: number;
          };
          protocol?: McpProtocol;
        } | {
          type: "remote";
          url: string;
          headers?: {
            [x: string]: string;
          };
          oauth?: {
            client_id?: string;
            client_secret?: string;
            scope?: string;
            callback_port?: number;
            redirect_uri?: string;
            auth_server_metadata_url?: string;
          } | false;
          disabled?: boolean;
          codemode?: boolean;
          timeout?: {
            startup?: number;
            catalog?: number;
            execution?: number;
          };
          protocol?: McpProtocol;
        };
      };
    };
    compaction?: {
      auto?: boolean;
      keep?: {
        tokens?: number;
      };
      buffer?: number;
    };
    skills?: Array<string>;
    commands?: {
      [x: string]: {
        template: string;
        description?: string;
        agent?: string;
        model?: string | {
          providerID: string;
          model: string;
          variant?: string;
        };
        subagent?: boolean;
        subtask?: boolean;
      };
    };
    instructions?: Array<string>;
    references?: {
      [x: string]: string | {
        repository: string;
        branch?: string;
        description?: string;
        hidden?: boolean;
      } | {
        path: string;
        description?: string;
        hidden?: boolean;
      };
    };
    websearch?: false | {
      provider: "random" | (string & {});
    };
    plugins?: Array<string | {
      package: string;
      options?: {
        [x: string]: JsonValue;
      };
    }>;
    worktree?: ConfigWorktree;
    warming?: boolean | {
      prompt?: string;
      interval?: string;
      duration?: string;
    };
    providers?: {
      [x: string]: {
        canonical?: string;
        name?: string;
        env?: Array<string>;
        package?: string;
        settings?: ConfigProviderSettings;
        headers?: {
          [x: string]: string;
        };
        body?: {
          [x: string]: JsonValue;
        };
        models?: {
          [x: string]: {
            modelID?: string;
            family?: string;
            name?: string;
            compatibility?: ModelCompatibility;
            package?: string;
            settings?: ConfigModelSettings;
            headers?: {
              [x: string]: string;
            };
            body?: {
              [x: string]: JsonValue;
            };
            capabilities?: ModelCapabilities;
            variants?: Array<{
              id: string;
              settings?: ConfigModelSettings;
              headers?: {
                [x: string]: string;
              };
              body?: {
                [x: string]: JsonValue;
              };
            }>;
            cost?: {
              tier?: {
                type: "context";
                size: number;
              };
              input: MoneyUSDPerMillionTokens;
              output: MoneyUSDPerMillionTokens;
              cache?: {
                read?: MoneyUSDPerMillionTokens;
                write?: MoneyUSDPerMillionTokens;
              };
            } | Array<{
              tier?: {
                type: "context";
                size: number;
              };
              input: MoneyUSDPerMillionTokens;
              output: MoneyUSDPerMillionTokens;
              cache?: {
                read?: MoneyUSDPerMillionTokens;
                write?: MoneyUSDPerMillionTokens;
              };
            }>;
            disabled?: boolean;
            limit?: {
              context?: number;
              input?: number;
              output?: number;
            };
          };
        };
      };
    };
    experimental?: {
      portable_shell_scanner?: boolean;
      subagent_depth?: number;
      policies?: Array<{
        action: "provider.use" | "permission";
        resource: string;
        effect: "allow" | "deny";
      }>;
    };
  };
} | {
  type: "directory";
  path: string;
};

export type SessionInboxItem = {
  type: "user";
  payload: SessionInboxUserPayload1;
  delivery: SessionInboxDelivery;
} | {
  type: "synthetic";
  payload: SessionInboxSyntheticPayload1;
  delivery: SessionInboxDelivery;
} | {
  type: "compaction";
  payload: SessionInboxCompactionPayload;
  delivery: SessionInboxDelivery;
} | {
  type: "move";
  payload: SessionInboxMovePayload1;
  delivery: SessionInboxDelivery;
};

export type SessionMessageAssistantTool = {
  type: "tool";
  id: string;
  name: string;
  executed?: boolean;
  providerState?: SessionMessageProviderState;
  providerResultState?: SessionMessageProviderState;
  state: SessionMessageToolStateStreaming | SessionMessageToolStateRunning | SessionMessageToolStateCompleted | SessionMessageToolStateError;
  time: {
    created: number;
    ran?: number;
    completed?: number;
  };
};

export type SessionMessageCompaction = SessionMessageCompactionRunning | SessionMessageCompactionCompleted | SessionMessageCompactionFailed;

export type FormFields = [FormField, ...Array<FormField>];

export type FormFields2 = [FormField1, ...Array<FormField1>];

export type SessionInboxEnqueued = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "session.inbox.enqueued";
  durable: {
    aggregateID: string;
    seq: number;
    version: 1;
  };
  location?: LocationRef;
  data: {
    sessionID: string;
    inboxID: string;
    item: SessionInboxItem;
  };
};

export type SessionMessageAssistant = {
  id: string;
  metadata?: {
    [x: string]: JsonValue;
  };
  time: {
    created: number;
    streamed?: number;
    completed?: number;
  };
  type: "assistant";
  agent: string;
  model: ModelRef;
  content: Array<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>;
  snapshot?: {
    start?: string;
    end?: string;
    files?: Array<string>;
  };
  finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
  rawFinish?: string;
  providerState?: SessionMessageProviderState;
  cost?: MoneyUSD;
  tokens?: TokenUsageInfo;
  error?: SessionStructuredError;
  retry?: SessionMessageAssistantRetry;
};

export type FormInfo = {
  id: string;
  sessionID: string;
  title: string;
  metadata?: FormMetadata;
  fields: FormFields;
};

export type FormInfo1 = {
  id: string;
  sessionID: string;
  title: string;
  metadata?: FormMetadata1;
  fields: FormFields2;
};

export type SessionMessageInfo = SessionMessageAgentSelected | SessionMessageModelSelected | SessionMessageLocationSwitched | SessionMessageUser | SessionMessageSynthetic | SessionMessageSystem | SessionMessageSkill | SessionMessageShell | SessionMessageAssistant | SessionMessageCompaction | SessionMessageIdle;

export type FormCreated = {
  id: string;
  created: number;
  metadata?: {
    [x: string]: any;
  };
  type: "form.created";
  location?: LocationRef;
  data: {
    form: FormInfo1;
  };
};

export type V2Event = LocationShutdown | ModelsDevRefreshed | CredentialUpdated | CredentialSwitched | IntegrationUpdated | ProviderUpdated | ModelUpdated | AgentUpdated | SessionCreated | SessionAgentSelected | SessionModelSelected | SessionMoved | SessionRenamed | SessionMetadataUpdated | SessionPermissions | SessionViewed | SessionUsageUpdated | SessionDeleted | SessionForked | SessionInboxDelivered | SessionInboxEnqueued | SessionInboxCancelled | SessionInboxDeliveryChanged | SessionExecutionStarted | SessionExecutionSucceeded | SessionExecutionFailed | SessionExecutionInterrupted | SessionInstructionsUpdated | SessionSynthetic | SessionSkillActivated | SessionShellStarted | SessionShellEnded | SessionStepStarted | SessionStepStreamed | SessionStepEnded | SessionStepFailed | SessionTextStarted | SessionTextDelta | SessionTextEnded | SessionReasoningStarted | SessionReasoningDelta | SessionReasoningEnded | SessionToolInputStarted | SessionToolInputDelta | SessionToolInputEnded | SessionToolCalled | SessionToolProgress | SessionToolSuccess | SessionToolFailed | SessionRetryScheduled | SessionCompactionStarted | SessionCompactionDelta | SessionCompactionEnded | SessionCompactionFailed | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted | FilesystemChanged | ReferenceUpdated | PermissionAsked | PermissionReplied | PluginUpdated | ProjectUpdated | WorktreeUpdated | WorktreeResolved | CommandUpdated | ConfigUpdated | SkillUpdated | PtyCreated | PtyUpdated | PtyExited | PtyDeleted | PersistentPtyAdded | PersistentPtyRemoved | ShellCreated | ShellExited | ShellDeleted | FormCreated | FormReplied | FormCancelled | WebsearchUpdated | SessionStatusUpdated | SessionIdle | TuiPromptAppend | TuiCommandExecute | TuiToastShow | TuiSessionSelect | InstallationUpdated | InstallationUpdateAvailable | VcsBranchUpdated | McpStatusChanged | McpResourcesChanged | V2EventRpc | V2EventServerConnected;

export type EventSubscribeOutput = V2Event;
