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
