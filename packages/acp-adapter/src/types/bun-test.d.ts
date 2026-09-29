// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by this package's test files is declared.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  export interface ExpectResult {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toContainEqual(expected: unknown): void
    rejects: {
      toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): Promise<void>
    }
  }
  export function expect(value: unknown): ExpectResult
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
}
