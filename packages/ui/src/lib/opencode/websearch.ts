/**
 * The `websearch` tool's result format, translated for chat.
 *
 * Two shapes meet here: the tool's text result — one `## [title](url)` block
 * per hit, an optional `Published: <ISO>` line, then the snippet — and the
 * consent form the tool raises on first use, tagged
 * `metadata.kind === "websearch.provider"`.
 */

import { z } from "zod"
import type { Config, FormRequest, Metadata } from "./model"

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  url: string
  host: string
  /** `null` when OpenCode had no title and repeated the URL instead. */
  title: string | null
  /** ISO timestamp. */
  published: string | null
  snippet: string | null
}

export type WebSearchOutput = { kind: "results"; results: WebSearchResult[] } | { kind: "empty" }

/** OpenCode's `NO_RESULTS` text. */
const NO_RESULTS_PREFIX = "No search results found."
const HEADING = /^## \[(.*)\]\((https?:\/\/\S+)\)$/
const PUBLISHED = /^Published: (\S+)$/

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * Reads the tool's text result. Returns `null` for anything that does not
 * follow OpenCode's format, so the caller can show the raw text instead.
 */
export function parseWebSearchOutput(content: string): WebSearchOutput | null {
  const text = content.trim()
  if (text.startsWith(NO_RESULTS_PREFIX)) return { kind: "empty" }
  const lines = text.split("\n")
  if (!HEADING.test(lines[0] ?? "")) return null

  const results: WebSearchResult[] = []
  let current: { url: string; host: string; title: string | null; published: string | null; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    const snippet = current.body.join("\n").trim()
    results.push({
      url: current.url,
      host: current.host,
      title: current.title,
      published: current.published,
      snippet: snippet.length > 0 ? snippet : null,
    })
  }

  for (const line of lines) {
    const heading = HEADING.exec(line)
    if (heading) {
      const [, title = "", url = ""] = heading
      const host = hostOf(url)
      if (!host) return null
      flush()
      current = { url, host, title: title && title !== url ? title : null, published: null, body: [] }
      continue
    }
    if (!current) return null
    // The date line comes right after the heading, before the blank line.
    const published = current.body.length === 0 && current.published === null ? PUBLISHED.exec(line) : null
    if (published) {
      current.published = published[1] ?? null
      continue
    }
    current.body.push(line)
  }
  flush()
  return { kind: "results", results }
}

/** The provider id OpenCode records on a finished or failed search. */
const resultMetadataSchema = z.object({ provider: z.string().min(1) })

export function webSearchProviderOf(metadata: Metadata | undefined): string | null {
  return resultMetadataSchema.safeParse(metadata).data?.provider ?? null
}

// ---------------------------------------------------------------------------
// Consent form
// ---------------------------------------------------------------------------

export interface WebSearchConsentOption {
  value: string
  /** OpenCode's English label; the card localizes the values it knows. */
  label: string
}

/**
 * The first-use consent form. `choice` answers allow / choose / disable;
 * `provider` is the follow-up list when the user picked "choose".
 */
export type WebSearchConsent =
  | { step: "choice"; fieldKey: string; options: WebSearchConsentOption[] }
  | { step: "provider"; fieldKey: string; options: WebSearchConsentOption[] }

/** `null` for any other form, or one whose shape this card does not know. */
export function readWebSearchConsent(form: FormRequest): WebSearchConsent | null {
  if (form.metadata?.kind !== "websearch.provider") return null
  if (form.fields.length !== 1) return null
  const [field] = form.fields
  if (!field || field.type !== "string" || !field.options?.length) return null
  const options = field.options.map((option) => ({ value: option.value, label: option.label }))
  if (field.key === "choice") return { step: "choice", fieldKey: field.key, options }
  if (field.key === "provider") return { step: "provider", fieldKey: field.key, options }
  return null
}
