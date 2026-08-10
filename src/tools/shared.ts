import type { ZoteroItem } from "../zotero/types.js";

const ZOTERO_ITEM_KEY = /^[A-Z0-9]{8}$/;

export function normalizeItemKey(itemKey: string): string {
  return itemKey.trim().toUpperCase();
}

export function isItemKey(itemKey: string): boolean {
  return ZOTERO_ITEM_KEY.test(itemKey);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function compactItem(item: ZoteroItem): Record<string, unknown> {
  const data = item.data;
  const creators = Array.isArray(data.creators)
    ? data.creators.map((creator) => {
        const raw = creator as Record<string, unknown>;
        return {
          ...(optionalString(raw.creatorType) === undefined
            ? {}
            : { creator_type: raw.creatorType }),
          ...(optionalString(raw.firstName) === undefined
            ? {}
            : { first_name: raw.firstName }),
          ...(optionalString(raw.lastName) === undefined
            ? {}
            : { last_name: raw.lastName }),
          ...(optionalString(raw.name) === undefined ? {} : { name: raw.name }),
        };
      })
    : [];
  const tags = Array.isArray(data.tags)
    ? data.tags
        .map((tag) =>
          typeof tag === "string"
            ? tag
            : optionalString((tag as Record<string, unknown>).tag),
        )
        .filter((tag): tag is string => tag !== undefined)
    : [];

  return {
    key: item.key,
    version: item.version,
    item_type: data.itemType,
    ...(optionalString(data.title) === undefined ? {} : { title: data.title }),
    ...(optionalString(data.date) === undefined ? {} : { date: data.date }),
    ...(optionalString(data.publicationTitle) === undefined
      ? {}
      : { publication_title: data.publicationTitle }),
    ...(optionalString(data.DOI) === undefined ? {} : { doi: data.DOI }),
    ...(optionalString(data.url) === undefined ? {} : { url: data.url }),
    ...(optionalString(data.abstractNote) === undefined
      ? {}
      : { abstract: data.abstractNote }),
    ...(optionalString(data.parentItem) === undefined
      ? {}
      : { parent_item: data.parentItem }),
    ...(optionalString(data.contentType) === undefined
      ? {}
      : { content_type: data.contentType }),
    ...(optionalString(data.filename) === undefined
      ? {}
      : { filename: data.filename }),
    ...(creators.length === 0 ? {} : { creators }),
    ...(tags.length === 0 ? {} : { tags }),
  };
}

export function compactChild(item: ZoteroItem): Record<string, unknown> {
  const data = item.data;
  return {
    key: item.key,
    item_type: data.itemType,
    ...(optionalString(data.title) === undefined ? {} : { title: data.title }),
    ...(optionalString(data.contentType) === undefined
      ? {}
      : { content_type: data.contentType }),
    ...(optionalString(data.filename) === undefined
      ? {}
      : { filename: data.filename }),
    ...(optionalString(data.parentItem) === undefined
      ? {}
      : { parent_item: data.parentItem }),
  };
}

export function isPdfAttachment(item: ZoteroItem): boolean {
  if (item.data.itemType !== "attachment") return false;

  const contentType = optionalString(item.data.contentType)?.toLowerCase();
  const filename = optionalString(item.data.filename)?.toLowerCase();
  return (
    contentType?.startsWith("application/pdf") === true ||
    filename?.endsWith(".pdf") === true
  );
}

export function itemLabel(item: ZoteroItem): string {
  return (
    optionalString(item.data.title) ??
    optionalString(item.data.filename) ??
    "Untitled item"
  );
}
