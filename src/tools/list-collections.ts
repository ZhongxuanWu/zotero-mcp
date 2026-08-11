import { z } from "zod";

import { toolError, toolSuccess } from "./result.js";
import type { ZoteroToolClient } from "./types.js";

export const listCollectionsInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of collections to return (1-100)."),
    start: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Zero-based pagination offset in depth-first tree order."),
  })
  .strict();

export async function listCollections(
  client: ZoteroToolClient,
  input: z.output<typeof listCollectionsInputSchema>,
) {
  try {
    const page = await client.listCollections({
      limit: input.limit,
      start: input.start,
    });
    const collections = page.items.map(({ collection, path, depth }) => ({
      key: collection.key,
      name: collection.data.name,
      path,
      depth,
      parent_collection_key:
        collection.data.parentCollection === false
          ? null
          : collection.data.parentCollection,
      item_count: collection.meta?.numItems ?? null,
      subcollection_count: collection.meta?.numCollections ?? null,
    }));
    const output = {
      collections,
      focused_collection_key: page.focusedCollectionKey,
      total_results: page.totalResults,
      start: page.start,
      returned: collections.length,
      next_start: page.nextStart ?? null,
    };
    const lines = collections.map(
      (collection) => `- ${collection.key}: ${collection.path.join(" / ")}`,
    );
    const pagination =
      output.next_start === null ? "" : ` Next start: ${output.next_start}.`;
    const focus =
      page.focusedCollectionKey === null
        ? "the configured Zotero library"
        : `collection ${page.focusedCollectionKey} and its descendants`;
    const text = [
      `Found ${collections.length} of ${page.totalResults} collections in ${focus}.${pagination}`,
      ...lines,
    ].join("\n");
    return toolSuccess(output, text);
  } catch (error) {
    return toolError(error);
  }
}
