/**
 * Whether the server has the OMP runtime mounted.
 *
 * The OMP routes are registered only when `OPENCHAMBER_OMP_RUNTIME=1`, so a 404
 * on the status route is the authoritative "off". A probe failure is treated as
 * unavailable: the affordance stays hidden rather than offering a runtime the
 * server cannot serve.
 */

import { useEffect, useState } from "react"
import { runtimeFetch } from "@/lib/runtime-fetch"

let cachedProbe: Promise<boolean> | null = null

/** True when the server has the OMP runtime mounted. Probed once, then cached. */
export const isOmpRuntimeAvailable = (): Promise<boolean> => {
  cachedProbe ??= runtimeFetch("/api/agents/omp/status", { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false)
  return cachedProbe
}

/** Clears the cache so the next probe re-reads the server (e.g. after the setting changes). */
export const resetOmpRuntimeAvailable = (): void => {
  cachedProbe = null
}

/** Probes only while enabled, so a surface that is never opened costs no request. */
export const useOmpRuntimeAvailable = (enabled = true): boolean => {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void isOmpRuntimeAvailable().then((value) => {
      if (active) setAvailable(value)
    })
    return () => {
      active = false
    }
  }, [enabled])
  return available
}