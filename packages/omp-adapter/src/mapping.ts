import type { OmpModelInfo, OmpThinkingEffort } from "./model"
import type { OmpSessionInfo } from "./runtime"

/** The fields `toOmpSessionInfo` reads. Structurally satisfied by the SDK's `SessionInfo`. */
export type OmpSessionInfoLike = {
  id: string
  path: string
  cwd: string
  title?: string
}

export const toOmpSessionInfo = (info: OmpSessionInfoLike): OmpSessionInfo => ({
  id: info.id,
  sessionPath: info.path,
  cwd: info.cwd,
  title: info.title ?? "",
})

const THINKING_EFFORTS: readonly OmpThinkingEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"]

const isThinkingEffort = (value: unknown): value is OmpThinkingEffort =>
  THINKING_EFFORTS.includes(value as OmpThinkingEffort)

/**
 * Normalizes OMP's `Model` for the picker: the raw fields are spread through
 * untouched and the thinking capability is lifted to top-level `reasoning`,
 * `efforts` and `defaultLevel`. A model without a `thinking` config projects
 * `efforts: []`, which is the picker's signal to hide the effort control —
 * offering a level OMP would reject is worse than offering none.
 */
export const toOmpModelInfo = (model: unknown): OmpModelInfo => {
  const record = model && typeof model === "object" ? (model as Record<string, unknown>) : {}
  const thinking =
    record.thinking && typeof record.thinking === "object" ? (record.thinking as Record<string, unknown>) : undefined
  const defaultLevel = isThinkingEffort(thinking?.defaultLevel) ? thinking.defaultLevel : undefined
  return {
    ...record,
    id: typeof record.id === "string" ? record.id : "",
    provider: typeof record.provider === "string" ? record.provider : "",
    reasoning: record.reasoning === true,
    efforts: Array.isArray(thinking?.efforts) ? thinking.efforts.filter(isThinkingEffort) : [],
    ...(defaultLevel ? { defaultLevel } : {}),
  }
}
