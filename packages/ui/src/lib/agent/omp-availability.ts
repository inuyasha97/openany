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

const probeOmpRuntime = (): Promise<boolean> => {
  cachedProbe ??= runtimeFetch("/api/agents/omp/status")
    .then((response) => response.ok)
    .catch(() => false)
  return cachedProbe
}

/** Probes only while enabled, so a surface that is never opened costs no request. */
export const useOmpRuntimeAvailable = (enabled = true): boolean => {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void probeOmpRuntime().then((value) => {
      if (active) setAvailable(value)
    })
    return () => {
      active = false
    }
  }, [enabled])
  return available
}