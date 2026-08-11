import { ZoteroApiError } from "./errors.js";
import type { LibraryLocator } from "./types.js";

const LIBRARY_SELECTOR_PATTERN = /^(user|group):(\d+)$/;
const COLLECTION_KEY_PATTERN = /^[A-Z0-9]{8}$/;

export const LIBRARY_SELECTOR_HELP =
  "Expected user:<positive-id> or group:<positive-id>.";
export const COLLECTION_KEY_HELP =
  "Expected an 8-character Zotero collection key.";

export function parseLibrarySelector(selector: string): LibraryLocator {
  const match = LIBRARY_SELECTOR_PATTERN.exec(selector.trim());
  const id = match === null ? Number.NaN : Number(match[2]);

  if (match === null || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `Invalid Zotero library selector: ${JSON.stringify(selector)}. ${LIBRARY_SELECTOR_HELP}`,
    );
  }

  return { type: match[1] as LibraryLocator["type"], id };
}

export function requireLibraryLocator(locator: LibraryLocator): LibraryLocator {
  if (
    (locator.type !== "user" && locator.type !== "group") ||
    !Number.isSafeInteger(locator.id) ||
    locator.id <= 0
  ) {
    throw new ZoteroApiError(
      "invalid_request",
      `The Zotero library must have type "user" or "group" and a positive numeric ID.`,
    );
  }

  return { type: locator.type, id: locator.id };
}

export function libraryApiPath(locator: LibraryLocator): string {
  return `/${locator.type === "user" ? "users" : "groups"}/${locator.id}`;
}

export function requireCollectionKey(collectionKey: string): string {
  const normalized = collectionKey.trim().toUpperCase();
  if (!COLLECTION_KEY_PATTERN.test(normalized)) {
    throw new ZoteroApiError(
      "invalid_request",
      `Invalid Zotero collection key: ${JSON.stringify(collectionKey)}. ${COLLECTION_KEY_HELP}`,
    );
  }
  return normalized;
}
