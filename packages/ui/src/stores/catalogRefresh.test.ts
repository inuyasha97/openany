import { describe, expect, test } from "bun:test";

import { catalogRefreshTasks } from "./catalogRefresh";

describe("catalogRefreshTasks", () => {
  test("a config rebuild re-reads every list a config file can carry", () => {
    // Agents, commands, skills, MCP servers and providers all live in config.
    // Plugins and web search do not exist on this runtime, so they refresh
    // nothing.
    expect(catalogRefreshTasks("config")).toHaveLength(5);
  });

  test("a single-catalog rebuild re-reads only that list", () => {
    for (const kind of ["agent", "command", "skill", "provider"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(1);
    }
    for (const kind of ["plugin", "websearch"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(0);
    }
  });

  test("a credential change re-reads providers", () => {
    expect(catalogRefreshTasks("credential")).toHaveLength(1);
  });

  test("projects belong to the sync stores, not to the settings lists", () => {
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});
