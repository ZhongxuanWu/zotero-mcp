import { ZoteroApiError } from "./errors.js";
import type { LibraryLocator } from "./types.js";

const LIBRARY_SELECTOR_PATTERN = /^(user|group):(\d+)$/;

export const LIBRARY_SELECTOR_HELP =
  "Expected user:<positive-id> or group:<positive-id>.";

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
