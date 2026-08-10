import type {
  ZoteroFulltext,
  ZoteroItem,
  ZoteroPage,
  ZoteroPageOptions,
  ZoteroSearchItemsOptions,
} from "../zotero/types.js";

/** The subset of the Zotero Web API client used by the MCP tools. */
export interface ZoteroToolClient {
  searchItems(
    options?: ZoteroSearchItemsOptions,
  ): Promise<ZoteroPage<ZoteroItem>>;
  getItem(itemKey: string): Promise<ZoteroItem>;
  getItemChildren(
    itemKey: string,
    options?: ZoteroPageOptions,
  ): Promise<ZoteroPage<ZoteroItem>>;
  getFulltext(attachmentKey: string): Promise<ZoteroFulltext>;
}

export interface ToolErrorDetails {
  [key: string]: unknown;
}

export interface ToolErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: ToolErrorDetails;
  };
}
