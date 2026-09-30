/**
 * Whether the server has the ACP runtime mounted.
 *
 * Same probe shape as `omp-availability.ts`: the routes exist only when
 * `OPENCHAMBER_ACP_RUNTIME=1`, so a 404 on the status route is "off". A probe
 * failure is treated as unavailable; the affordance stays hidden.
 */

import { useEffect, useState } from "react"
import { runtimeFetch } from "@/lib/runtime-fetch"

let cachedProbe: Promise<boolean> | null = null

/** True when the server has the ACP runtime mounted. Probed once, then cached. */
export const isAcpRuntimeAvailable = (): Promise<boolean> => {
  cachedProbe ??= runtimeFetch("/api/agents/acp/status", { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false)
  return cachedProbe
}

/** Clears the cache so the next probe re-reads the server (e.g. after the setting changes). */
export const resetAcpRuntimeAvailable = (): void => {
  cachedProbe = null
}

/** Probes only while enabled, so a surface that is never opened costs no request. */
export const useAcpRuntimeAvailable = (enabled = true): boolean => {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void isAcpRuntimeAvailable().then((value) => {
      if (active) setAvailable(value)
    })
    return () => {
      active = false
    }
  }, [enabled])
  return available
}
