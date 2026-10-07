// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by this package's test files is declared.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void
  export interface ExpectResult {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toMatchObject(expected: unknown): void
    toBeNull(): void
    toBeInstanceOf(expected: unknown): void
    toHaveLength(expected: number): void
    toHaveProperty(key: string): void
    not: ExpectResult
    rejects: {
      toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): Promise<void>
      toBeInstanceOf(expected: unknown): Promise<void>
    }
  }
  export function expect(value: unknown): ExpectResult
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
}
