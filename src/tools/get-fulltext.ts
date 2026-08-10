import { z } from "zod";

import type { ZoteroItem } from "../zotero/types.js";
import { ToolFailure, toolError, toolSuccess } from "./result.js";
import {
  compactChild,
  isItemKey,
  isPdfAttachment,
  itemLabel,
  normalizeItemKey,
} from "./shared.js";
import type { ZoteroToolClient } from "./types.js";

const CHILD_PAGE_SIZE = 100;
const MAX_CHILD_PAGES = 100;

export const getFulltextInputSchema = z
  .object({
    item_key: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine(isItemKey, "item_key must be an 8-character Zotero item key."),
    attachment_key: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine(
        isItemKey,
        "attachment_key must be an 8-character Zotero item key.",
      )
      .optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Character offset into Zotero's indexed text."),
    max_chars: z
      .number()
      .int()
      .min(1)
      .max(50_000)
      .default(20_000)
      .describe("Maximum characters to return (1-50000)."),
  })
  .strict();

async function listAllChildren(
  client: ZoteroToolClient,
  parentKey: string,
): Promise<ZoteroItem[]> {
  const children: ZoteroItem[] = [];
  const seenStarts = new Set<number>();
  let start = 0;

  for (let pageNumber = 0; pageNumber < MAX_CHILD_PAGES; pageNumber += 1) {
    if (seenStarts.has(start)) {
      throw new ToolFailure(
        "invalid_zotero_pagination",
        "Zotero returned an invalid child-item pagination cursor.",
      );
    }
    seenStarts.add(start);

    const page = await client.getItemChildren(parentKey, {
      limit: CHILD_PAGE_SIZE,
      start,
    });
    children.push(...page.items);
    if (page.nextStart === null) return children;
    start = page.nextStart;
  }

  throw new ToolFailure(
    "too_many_child_items",
    "The item has too many child items to resolve a PDF attachment safely.",
  );
}

function assertPdfAttachment(item: ZoteroItem): void {
  if (!isPdfAttachment(item)) {
    throw new ToolFailure(
      "not_a_pdf_attachment",
      `${item.key} is not a PDF attachment.`,
    );
  }
}

async function resolveAttachment(
  client: ZoteroToolClient,
  item: ZoteroItem,
  requestedAttachmentKey: string | undefined,
): Promise<ZoteroItem> {
  if (requestedAttachmentKey !== undefined) {
    const attachment = await client.getItem(requestedAttachmentKey);
    assertPdfAttachment(attachment);

    if (item.data.itemType === "attachment") {
      if (attachment.key !== item.key) {
        throw new ToolFailure(
          "attachment_mismatch",
          "attachment_key must match item_key when item_key is an attachment.",
        );
      }
      return attachment;
    }

    if (attachment.data.parentItem !== item.key) {
      throw new ToolFailure(
        "attachment_not_child",
        `${attachment.key} is not a child of ${item.key}.`,
      );
    }
    return attachment;
  }

  if (item.data.itemType === "attachment") {
    assertPdfAttachment(item);
    return item;
  }

  const children = await listAllChildren(client, item.key);
  const candidates = children.filter(isPdfAttachment);
  if (candidates.length === 0) {
    throw new ToolFailure(
      "pdf_attachment_not_found",
      `No PDF attachment was found for ${item.key}.`,
    );
  }
  if (candidates.length > 1) {
    throw new ToolFailure(
      "multiple_pdf_attachments",
      `More than one PDF attachment was found for ${item.key}; provide attachment_key.`,
      { details: { candidates: candidates.map(compactChild) } },
    );
  }

  return candidates[0] as ZoteroItem;
}

export async function getFulltext(
  client: ZoteroToolClient,
  input: z.output<typeof getFulltextInputSchema>,
) {
  try {
    const itemKey = normalizeItemKey(input.item_key);
    const attachmentKey =
      input.attachment_key === undefined
        ? undefined
        : normalizeItemKey(input.attachment_key);
    const item = await client.getItem(itemKey);
    const attachment = await resolveAttachment(client, item, attachmentKey);
    const fulltext = await client.getFulltext(attachment.key);
    const textLength = fulltext.content.length;
    if (input.offset > textLength) {
      throw new ToolFailure(
        "offset_out_of_range",
        `offset must not exceed the available indexed text length (${textLength}).`,
        { details: { available_text_chars: textLength } },
      );
    }
    const text = fulltext.content.slice(
      input.offset,
      input.offset + input.max_chars,
    );
    const endOffset = input.offset + text.length;
    const truncated = endOffset < textLength;
    const partialIndex =
      (fulltext.indexedPages !== undefined &&
        fulltext.totalPages !== undefined &&
        fulltext.indexedPages < fulltext.totalPages) ||
      (fulltext.indexedChars !== undefined &&
        fulltext.totalChars !== undefined &&
        fulltext.indexedChars < fulltext.totalChars);
    const output = {
      item: {
        key: item.key,
        item_type: item.data.itemType,
        title: itemLabel(item),
      },
      attachment: compactChild(attachment),
      text,
      offset: input.offset,
      returned_chars: text.length,
      available_text_chars: textLength,
      truncated,
      next_offset: truncated ? endOffset : null,
      indexed_pages: fulltext.indexedPages ?? null,
      total_pages: fulltext.totalPages ?? null,
      indexed_chars: fulltext.indexedChars ?? null,
      total_chars: fulltext.totalChars ?? null,
      partial_index: partialIndex,
    };
    const partialIndexWarning =
      fulltext.indexedPages !== undefined &&
      fulltext.totalPages !== undefined &&
      fulltext.indexedPages < fulltext.totalPages
        ? `Warning: Zotero reports ${fulltext.indexedPages} of ${fulltext.totalPages} pages indexed.`
        : fulltext.indexedChars !== undefined &&
            fulltext.totalChars !== undefined &&
            fulltext.indexedChars < fulltext.totalChars
          ? `Warning: Zotero reports ${fulltext.indexedChars} of ${fulltext.totalChars} characters indexed.`
          : undefined;
    const header = [
      `Indexed text from ${attachment.key}: characters ${input.offset}-${endOffset} of ${textLength}.`,
      partialIndexWarning,
      truncated ? `Continue with offset ${endOffset}.` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");

    return toolSuccess(output, `${header}\n\n${text}`);
  } catch (error) {
    return toolError(error);
  }
}
