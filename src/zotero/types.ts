export type ZoteroSearchMode = "titleCreatorYear" | "everything";

export interface LibraryLocator {
  type: "user" | "group";
  id: number;
}

export interface ZoteroClientOptions {
  apiKey?: string;
  library?: LibraryLocator;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface ZoteroPageOptions {
  limit?: number;
  start?: number;
}

export interface ZoteroSearchItemsOptions extends ZoteroPageOptions {
  q?: string;
  qmode?: ZoteroSearchMode;
  itemType?: string;
  tag?: string | readonly string[];
}

export interface ZoteroPage<T> {
  items: T[];
  totalResults: number;
  start: number;
  limit: number;
  nextStart: number | null;
}

export interface ZoteroKeyAccess {
  library?: boolean;
  files?: boolean;
  notes?: boolean;
  write?: boolean;
  [permission: string]: unknown;
}

export interface ZoteroKeyInfo {
  userID: number;
  username?: string;
  access: {
    user?: ZoteroKeyAccess;
    groups?: Record<string, unknown>;
    [scope: string]: unknown;
  };
}

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  [field: string]: unknown;
}

export interface ZoteroTag {
  tag: string;
  type?: number;
  [field: string]: unknown;
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  abstractNote?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  DOI?: string;
  url?: string;
  tags?: ZoteroTag[];
  collections?: string[];
  parentItem?: string;
  linkMode?: string;
  contentType?: string;
  filename?: string;
  note?: string;
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library?: {
    type?: string;
    id?: number;
    name?: string;
    [field: string]: unknown;
  };
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  data: ZoteroItemData;
}

export interface ZoteroFulltext {
  content: string;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
}
