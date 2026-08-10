import { z } from "zod";

import { compactItem } from "./shared.js";
import { toolError, toolSuccess } from "./result.js";
import type { ZoteroToolClient } from "./types.js";

export const searchItemsInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Text to search for in the Zotero library."),
    search_mode: z
      .enum(["metadata", "everything"])
      .default("metadata")
      .describe(
        "Search title, creators, and year, or search all indexed fields and full text.",
      ),
    item_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional Zotero item type filter, such as journalArticle or book.",
      ),
    tag: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional Zotero tag-search expression; use a tag name for a literal match.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum number of items to return (1-100)."),
    start: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Zero-based pagination offset."),
  })
  .strict();

export async function searchItems(
  client: ZoteroToolClient,
  input: z.output<typeof searchItemsInputSchema>,
) {
  try {
    const page = await client.searchItems({
      ...(input.query === undefined ? {} : { q: input.query }),
      qmode:
        input.search_mode === "everything" ? "everything" : "titleCreatorYear",
      ...(input.item_type === undefined ? {} : { itemType: input.item_type }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      limit: input.limit,
      start: input.start,
    });
    const items = page.items.map(compactItem);
    const output = {
      items,
      total_results: page.totalResults,
      start: page.start,
      returned: items.length,
      next_start: page.nextStart ?? null,
    };
    const lines = items.map((item) => {
      const title =
        typeof item.title === "string" ? item.title : "Untitled item";
      const date = typeof item.date === "string" ? ` (${item.date})` : "";
      return `- ${String(item.key)}: ${title}${date}`;
    });
    const pagination =
      output.next_start === null ? "" : ` Next start: ${output.next_start}.`;
    const text = [
      `Found ${items.length} of ${page.totalResults} Zotero items.${pagination}`,
      ...lines,
    ].join("\n");

    return toolSuccess(output, text);
  } catch (error) {
    return toolError(error);
  }
}
