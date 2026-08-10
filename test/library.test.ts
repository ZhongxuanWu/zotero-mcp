import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { libraryApiPath, parseLibrarySelector } from "../src/zotero/library.js";

describe("Zotero library selectors", () => {
  it.each([
    ["user:1", { type: "user", id: 1 }, "/users/1"],
    ["user:001", { type: "user", id: 1 }, "/users/1"],
    ["group:123456", { type: "group", id: 123456 }, "/groups/123456"],
  ] as const)("parses %s", (selector, expected, expectedPath) => {
    const library = parseLibrarySelector(selector);

    expect(library).toEqual(expected);
    expect(libraryApiPath(library)).toBe(expectedPath);
  });

  it.each([
    "",
    "user",
    "user:",
    "user:0",
    "user:-1",
    "user:1.5",
    "group:not-a-number",
    "collection:123",
    "GROUP:123",
    `group:${String(Number.MAX_SAFE_INTEGER + 1)}`,
  ])("rejects malformed selector %j", (selector) => {
    expect(() => parseLibrarySelector(selector)).toThrow(
      /user:<positive-id> or group:<positive-id>/,
    );
  });
});

describe("CLI library validation", () => {
  function runCli(args: readonly string[]) {
    const environment = { ...process.env };
    delete environment.ZOTERO_API_KEY;

    return spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), ...args],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: environment,
        timeout: 10_000,
      },
    );
  }

  it("keeps missing legacy authentication at exit code 1", () => {
    const result = runCli([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ZOTERO_API_KEY is required when --library is omitted",
    );
  });

  it.each([
    [["--library"], /requires a value/],
    [["--library", "--help"], /requires a value/],
    [["--library", "team:123"], /Invalid Zotero library selector/],
    [["--library", "group:0"], /Invalid Zotero library selector/],
    [["unexpected", "--version"], /Unknown argument/],
    [
      ["--library", "group:123", "--library", "user:456"],
      /only be provided once/,
    ],
  ] as const)("reports invalid arguments with exit code 2", (args, message) => {
    const result = runCli(args);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain("zotero-mcp --help");
  });
});
