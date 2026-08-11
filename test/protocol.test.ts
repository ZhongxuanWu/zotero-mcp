import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createZoteroMcpServer } from "../src/server.js";
import type { ZoteroItem } from "../src/zotero/types.js";
import type { ZoteroToolClient } from "../src/tools/types.js";

function item(key: string): ZoteroItem {
  return {
    key,
    version: 1,
    data: {
      key,
      version: 1,
      itemType: "journalArticle",
      title: "Protocol test",
    },
  };
}

function mockClient(): ZoteroToolClient {
  return {
    listCollections: vi.fn(async () => ({
      items: [],
      totalResults: 0,
      start: 0,
      limit: 50,
      nextStart: null,
      focusedCollectionKey: null,
    })),
    searchItems: vi.fn(async () => ({
      items: [item("ABCD1234")],
      totalResults: 1,
      start: 0,
      limit: 20,
      nextStart: null,
    })),
    getItem: vi.fn(async (key) => item(key)),
    getItemChildren: vi.fn(async () => ({
      items: [],
      totalResults: 0,
      start: 0,
      limit: 100,
      nextStart: null,
    })),
    getFulltext: vi.fn(async () => ({ content: "Protocol text" })),
  };
}

describe("MCP protocol", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  async function connect() {
    const server = createZoteroMcpServer(mockClient());
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => client.close());
    closers.push(async () => server.close());
    return client;
  }

  it("initializes and advertises exactly four read-only open-world tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(client.getServerVersion()).toMatchObject({
      name: "zotero-mcp",
      version: "0.1.0",
    });
    expect(client.getInstructions()).toContain("zotero_search_items");
    expect(tools.map((tool) => tool.name)).toEqual([
      "zotero_list_collections",
      "zotero_search_items",
      "zotero_get_item",
      "zotero_get_fulltext",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("returns structured content and rejects input outside the schema", async () => {
    const client = await connect();
    await client.listTools();

    const result = await client.callTool({
      name: "zotero_search_items",
      arguments: { query: "protocol", limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total_results: 1,
      returned: 1,
      items: [{ key: "ABCD1234", title: "Protocol test" }],
    });
    expect(result.content).toEqual([expect.objectContaining({ type: "text" })]);

    const invalidResult = await client.callTool({
      name: "zotero_search_items",
      arguments: { limit: 101 },
    });
    expect(invalidResult).toMatchObject({ isError: true });
    expect(invalidResult.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Input validation error"),
      }),
    ]);
  });
});
