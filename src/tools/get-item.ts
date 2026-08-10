import { z } from "zod";

import {
  compactChild,
  isItemKey,
  itemLabel,
  normalizeItemKey,
} from "./shared.js";
import { ToolFailure, toolError, toolSuccess } from "./result.js";
import type { ZoteroToolClient } from "./types.js";

export const getItemInputSchema = z
  .object({
    item_key: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine(isItemKey, "item_key must be an 8-character Zotero item key."),
  })
  .strict();

export async function getItem(
  client: ZoteroToolClient,
  input: z.output<typeof getItemInputSchema>,
) {
  try {
    const itemKey = normalizeItemKey(input.item_key);
    if (!isItemKey(itemKey)) {
      throw new ToolFailure(
        "invalid_item_key",
        "item_key must be an 8-character Zotero item key.",
      );
    }

    const item = await client.getItem(itemKey);
    const childPage =
      item.data.parentItem === undefined
        ? await client.getItemChildren(itemKey, { limit: 100, start: 0 })
        : {
            items: [],
            totalResults: 0,
            start: 0,
            limit: 100,
            nextStart: null,
          };
    const children = childPage.items.map(compactChild);
    const output = {
      item: {
        key: item.key,
        version: item.version,
        ...(item.library === undefined ? {} : { library: item.library }),
        data: item.data,
      },
      children,
      total_children: childPage.totalResults,
      children_truncated: childPage.nextStart !== null,
      next_children_start: childPage.nextStart ?? null,
    };
    const text = [
      `${itemLabel(item)} (${item.data.itemType}, ${item.key})`,
      `Children: ${children.length} of ${childPage.totalResults}`,
      JSON.stringify(item.data),
    ].join("\n");

    return toolSuccess(output, text);
  } catch (error) {
    return toolError(error);
  }
}
