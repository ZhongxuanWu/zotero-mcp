import { McpServer } from "@modelcontextprotocol/server";

import { registerZoteroTools, type ZoteroToolClient } from "./tools/index.js";

export const SERVER_NAME = "zotero-mcp";
export const SERVER_VERSION = "0.1.0";

export function createZoteroMcpServer(
  client: ZoteroToolClient,
  version = SERVER_VERSION,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        "These read-only tools access the configured synchronized Zotero library. Start with zotero_search_items, inspect a result with zotero_get_item, then use zotero_get_fulltext for Zotero-indexed PDF text. If a parent has multiple PDFs, choose a returned attachment_key. Follow next_start and next_offset to retrieve additional chunks; do not assume truncated results are complete.",
    },
  );
  registerZoteroTools(server, client);
  return server;
}
