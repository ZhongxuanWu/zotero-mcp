import type { McpServer } from "@modelcontextprotocol/server";

import { getFulltext, getFulltextInputSchema } from "./get-fulltext.js";
import { getItem, getItemInputSchema } from "./get-item.js";
import { searchItems, searchItemsInputSchema } from "./search-items.js";
import type { ZoteroToolClient } from "./types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerZoteroTools(
  server: McpServer,
  client: ZoteroToolClient,
): void {
  server.registerTool(
    "zotero_search_items",
    {
      title: "Search Zotero items",
      description:
        "Search and paginate top-level items in the user's personal Zotero library. Returns compact metadata; use zotero_get_item for full item data.",
      inputSchema: searchItemsInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => searchItems(client, input),
  );

  server.registerTool(
    "zotero_get_item",
    {
      title: "Get a Zotero item",
      description:
        "Read one Zotero item by key, including its full editable data and compact descriptors for up to 100 child items.",
      inputSchema: getItemInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => getItem(client, input),
  );

  server.registerTool(
    "zotero_get_fulltext",
    {
      title: "Get Zotero indexed full text",
      description:
        "Read a bounded chunk of Zotero's indexed PDF text. item_key may identify a PDF attachment or its parent; ambiguous parents require attachment_key.",
      inputSchema: getFulltextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => getFulltext(client, input),
  );
}

export type { ZoteroToolClient } from "./types.js";
