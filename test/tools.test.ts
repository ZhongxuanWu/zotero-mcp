import { describe, expect, it, vi } from "vitest";

import { ZoteroApiError } from "../src/zotero/errors.js";
import type { ZoteroItem, ZoteroPage } from "../src/zotero/types.js";
import {
  getFulltext,
  getFulltextInputSchema,
} from "../src/tools/get-fulltext.js";
import { getItem, getItemInputSchema } from "../src/tools/get-item.js";
import {
  searchItems,
  searchItemsInputSchema,
} from "../src/tools/search-items.js";
import type { ZoteroToolClient } from "../src/tools/types.js";

function item(key: string, data: Partial<ZoteroItem["data"]> = {}): ZoteroItem {
  return {
    key,
    version: 1,
    data: {
      key,
      version: 1,
      itemType: "journalArticle",
      ...data,
    },
  };
}

function page(
  items: ZoteroItem[],
  options: {
    totalResults?: number;
    start?: number;
    nextStart?: number | null;
  } = {},
): ZoteroPage<ZoteroItem> {
  return {
    items,
    totalResults: options.totalResults ?? items.length,
    start: options.start ?? 0,
    limit: 100,
    nextStart: options.nextStart ?? null,
  };
}

function mockClient(
  overrides: Partial<ZoteroToolClient> = {},
): ZoteroToolClient {
  return {
    searchItems: vi.fn(async () => page([])),
    getItem: vi.fn(async (key) => item(key)),
    getItemChildren: vi.fn(async () => page([])),
    getFulltext: vi.fn(async () => ({ content: "" })),
    ...overrides,
  };
}

function structured(result: Awaited<ReturnType<typeof searchItems>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("zotero_search_items", () => {
  it("applies defaults, maps search mode, and returns pagination metadata", async () => {
    const searchItemsMock = vi.fn(async () =>
      page(
        [
          item("ABCD1234", {
            title: "A useful paper",
            date: "2024",
            creators: [
              {
                creatorType: "author",
                firstName: "Ada",
                lastName: "Lovelace",
              },
            ],
            tags: [{ tag: "methods" }],
          }),
        ],
        { totalResults: 3, nextStart: 1 },
      ),
    );
    const client = mockClient({ searchItems: searchItemsMock });

    const result = await searchItems(
      client,
      searchItemsInputSchema.parse({ query: "paper" }),
    );

    expect(searchItemsMock).toHaveBeenCalledWith({
      q: "paper",
      qmode: "titleCreatorYear",
      limit: 20,
      start: 0,
    });
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      total_results: 3,
      returned: 1,
      next_start: 1,
      items: [
        {
          key: "ABCD1234",
          title: "A useful paper",
          creators: [
            {
              creator_type: "author",
              first_name: "Ada",
              last_name: "Lovelace",
            },
          ],
          tags: ["methods"],
        },
      ],
    });
  });

  it("maps safe Zotero errors and redacts unexpected errors", async () => {
    const limited = mockClient({
      searchItems: vi.fn(async () => {
        throw new ZoteroApiError("rate_limited", "Try again later.", {
          status: 429,
          retryAfterMs: 2_000,
        });
      }),
    });
    const limitedResult = await searchItems(
      limited,
      searchItemsInputSchema.parse({}),
    );
    expect(limitedResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "rate_limited",
          message: "Try again later.",
          retryable: true,
          details: { status: 429, retry_after_ms: 2_000 },
        },
      },
    });

    const unexpected = mockClient({
      searchItems: vi.fn(async () => {
        throw new Error("Authorization: Bearer VERY_SECRET_KEY");
      }),
    });
    const unexpectedResult = await searchItems(
      unexpected,
      searchItemsInputSchema.parse({}),
    );
    expect(JSON.stringify(unexpectedResult)).not.toContain("VERY_SECRET_KEY");
    expect(unexpectedResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "zotero_request_failed",
          retryable: false,
        },
      },
    });
  });
});

describe("zotero_get_item", () => {
  it("returns note HTML and does not request children for a child note", async () => {
    const getItemChildren = vi.fn(async () => page([]));
    const client = mockClient({
      getItem: vi.fn(async () =>
        item("NOTE1234", {
          itemType: "note",
          parentItem: "ABCD1234",
          note: "<p>Important observation</p>",
        }),
      ),
      getItemChildren,
    });

    const result = await getItem(
      client,
      getItemInputSchema.parse({ item_key: "note1234" }),
    );

    expect(getItemChildren).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      item: {
        key: "NOTE1234",
        data: { note: "<p>Important observation</p>" },
      },
      children: [],
      total_children: 0,
    });
  });

  it("returns a bounded child page and reports truncation", async () => {
    const client = mockClient({
      getItem: vi.fn(async () => item("ABCD1234", { title: "Parent" })),
      getItemChildren: vi.fn(async () =>
        page(
          [
            item("PDFX1234", {
              itemType: "attachment",
              parentItem: "ABCD1234",
              filename: "paper.pdf",
              contentType: "application/pdf",
            }),
          ],
          { totalResults: 150, nextStart: 100 },
        ),
      ),
    });

    const result = await getItem(
      client,
      getItemInputSchema.parse({ item_key: "ABCD1234" }),
    );

    expect(result.structuredContent).toMatchObject({
      total_children: 150,
      children_truncated: true,
      next_children_start: 100,
      children: [{ key: "PDFX1234", filename: "paper.pdf" }],
    });
  });
});

describe("zotero_get_fulltext", () => {
  it("resolves a unique PDF across child pages and chunks partial text", async () => {
    const getItemChildren = vi
      .fn()
      .mockResolvedValueOnce(
        page([item("NOTE1234", { itemType: "note" })], {
          totalResults: 2,
          nextStart: 1,
        }),
      )
      .mockResolvedValueOnce(
        page(
          [
            item("PDFX1234", {
              itemType: "attachment",
              parentItem: "ABCD1234",
              filename: "paper.pdf",
              contentType: "application/pdf",
            }),
          ],
          { totalResults: 2, start: 1 },
        ),
      );
    const client = mockClient({
      getItem: vi.fn(async () => item("ABCD1234", { title: "Parent" })),
      getItemChildren,
      getFulltext: vi.fn(async () => ({
        content: "0123456789",
        indexedPages: 2,
        totalPages: 3,
      })),
    });

    const result = await getFulltext(
      client,
      getFulltextInputSchema.parse({
        item_key: "ABCD1234",
        offset: 2,
        max_chars: 4,
      }),
    );

    expect(getItemChildren).toHaveBeenNthCalledWith(1, "ABCD1234", {
      limit: 100,
      start: 0,
    });
    expect(getItemChildren).toHaveBeenNthCalledWith(2, "ABCD1234", {
      limit: 100,
      start: 1,
    });
    expect(result.structuredContent).toMatchObject({
      attachment: { key: "PDFX1234" },
      text: "2345",
      offset: 2,
      returned_chars: 4,
      available_text_chars: 10,
      truncated: true,
      next_offset: 6,
      indexed_pages: 2,
      total_pages: 3,
      partial_index: true,
    });
  });

  it("returns candidate keys when a parent has multiple PDFs", async () => {
    const client = mockClient({
      getItem: vi.fn(async () => item("ABCD1234")),
      getItemChildren: vi.fn(async () =>
        page([
          item("PDFX1234", {
            itemType: "attachment",
            parentItem: "ABCD1234",
            filename: "one.pdf",
          }),
          item("PDFY1234", {
            itemType: "attachment",
            parentItem: "ABCD1234",
            filename: "two.pdf",
          }),
        ]),
      ),
    });

    const result = await getFulltext(
      client,
      getFulltextInputSchema.parse({ item_key: "ABCD1234" }),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "multiple_pdf_attachments",
          retryable: false,
          details: {
            candidates: [{ key: "PDFX1234" }, { key: "PDFY1234" }],
          },
        },
      },
    });
  });

  it("accepts a PDF attachment key directly and enforces the character cap", async () => {
    const attachment = item("PDFX1234", {
      itemType: "attachment",
      filename: "paper.pdf",
    });
    const getItemChildren = vi.fn(async () => page([]));
    const client = mockClient({
      getItem: vi.fn(async () => attachment),
      getItemChildren,
      getFulltext: vi.fn(async () => ({ content: "text" })),
    });

    const result = await getFulltext(
      client,
      getFulltextInputSchema.parse({ item_key: "PDFX1234" }),
    );
    expect(getItemChildren).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      attachment: { key: "PDFX1234" },
      text: "text",
      truncated: false,
      next_offset: null,
    });
    expect(() =>
      getFulltextInputSchema.parse({
        item_key: "PDFX1234",
        max_chars: 50_001,
      }),
    ).toThrow();
  });
});
