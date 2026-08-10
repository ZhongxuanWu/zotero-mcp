# zotero-mcp

`zotero-mcp` is a local, read-only Model Context Protocol (MCP) server for a
personal Zotero library. An MCP client such as Codex starts the npm package as
a child process, communicates with it over standard input/output, and the
process reads library data from the Zotero Web API over HTTPS.

You do not need to run Zotero Desktop or host a public server.

```text
Codex or another MCP client  <-- local stdio -->  zotero-mcp
                                                    |
                                                    +-- HTTPS --> api.zotero.org
```

The first release intentionally has a small scope: three read-only tools,
personal libraries, and Zotero-indexed full text.

## Requirements

- Node.js 20 or newer
- A Zotero account with a synced personal library
- A dedicated, read-only Zotero API key

## Create a read-only API key

1. Open [Zotero's API key settings](https://www.zotero.org/settings/keys/new)
   while signed in.
2. Give the key a recognizable name, such as `zotero-mcp`.
3. Enable read access for **Personal Library**.
4. Enable note access if you want `zotero_get_item` to return note bodies.
5. Leave write access and group access disabled.
6. Copy the generated key and store it somewhere secure.

Put the key in your environment instead of committing it to a configuration
file:

```bash
export ZOTERO_API_KEY="your-read-only-key"
```

For PowerShell:

```powershell
$env:ZOTERO_API_KEY = "your-read-only-key"
```

The server uses the key to discover the associated numeric Zotero user ID; no
separate user-ID setting is needed.

## Use with Codex

Add this server to `~/.codex/config.toml`:

```toml
[mcp_servers.zotero]
command = "npx"
args = ["-y", "@zhongxuanwu/zotero-mcp"]
env_vars = ["ZOTERO_API_KEY"]
```

Export `ZOTERO_API_KEY` before starting Codex, then restart Codex so it launches
the server with that environment variable. `env_vars` forwards the existing
value without copying the secret into `config.toml`.

After the package has been published, you can also install it globally:

```bash
npm install --global @zhongxuanwu/zotero-mcp
zotero-mcp --help
```

Then use `command = "zotero-mcp"` instead of `npx` in the Codex configuration.

## Use with other MCP clients

Configure a local stdio server whose command is `npx`, whose arguments are
`-y` and `@zhongxuanwu/zotero-mcp`, and whose environment includes
`ZOTERO_API_KEY`. Clients that use the common JSON configuration shape often
look similar to this:

```json
{
  "mcpServers": {
    "zotero": {
      "command": "npx",
      "args": ["-y", "@zhongxuanwu/zotero-mcp"],
      "env": {
        "ZOTERO_API_KEY": "your-read-only-key"
      }
    }
  }
}
```

Configuration formats and environment-variable forwarding differ among MCP
clients. Prefer the client's environment or secret-forwarding feature when it
has one. If a client requires the value in its configuration, keep that file
private and never commit it.

## Tools

### `zotero_search_items`

Search top-level items in the personal library. Its inputs are:

- `query` (optional): text to search
- `search_mode` (optional): `metadata` or `everything`
- `item_type` (optional): a Zotero item type such as `journalArticle`
- `tag` (optional): a Zotero tag
- `limit` (optional): page size, default `20`, maximum `100`
- `start` (optional): zero-based pagination offset

The result includes matching items and pagination metadata. This is Zotero API
search, not semantic or vector search.

### `zotero_get_item`

Get one item by its Zotero `item_key`. The result contains the complete item
data and compact descriptors for child notes and attachments. A child note or
attachment can also be requested directly by its own key.

### `zotero_get_fulltext`

Read text that Zotero has already indexed for a PDF attachment. Its inputs are:

- `item_key`: a parent item or attachment key
- `attachment_key` (optional): select a specific PDF attachment
- `offset` (optional): character offset, default `0`
- `max_chars` (optional): chunk size, default `20000`, maximum `50000`

If a parent has exactly one PDF attachment, the server selects it
automatically. If it has multiple PDFs, the result lists candidate attachment
keys so the caller can choose one. Results include truncation, next-offset, and
indexing-coverage information when available.

## Privacy and security

- The MCP process runs on your machine; this project does not operate a hosted
  relay or account service.
- The API key is sent only to Zotero's API over HTTPS. The server does not
  intentionally persist the key or library content.
- Tool results are returned to your MCP client and may be sent onward to the
  model or service configured by that client. Review that client's data policy
  before exposing sensitive library content.
- Use a dedicated read-only key. Revoke it at any time from Zotero's API key
  settings.
- Standard output is reserved for MCP protocol messages. Diagnostics go to
  standard error and must not include the API key.

## Current limitations

- Personal Zotero libraries only; group libraries are not supported.
- Read-only: no create, update, delete, upload, or annotation-writing tools.
- No OAuth flow. Authentication uses `ZOTERO_API_KEY`.
- No collection-browsing tool or local content cache.
- Note bodies require the key's separate note-read permission.
- Full text is limited to content already indexed and synced by Zotero. The
  server does not download or parse PDF files itself.
- The server uses stdio only; it does not expose an HTTP endpoint.

## Local development

```bash
git clone https://github.com/ZhongxuanWu/zotero-mcp.git
cd zotero-mcp
npm ci
npm run check
```

The automated test suite uses mocked Zotero responses and does not need an API
key. `npm run check` runs formatting, linting, type checking, tests, a build,
and a package-tarball smoke test.

For an optional manual test against your own library:

```bash
export ZOTERO_API_KEY="your-read-only-key"
npm run build
node dist/cli.js
```

The last command is an MCP stdio process, so waiting silently for protocol input
is expected. For a more useful live test, temporarily point your MCP client's
local server configuration at the built file:

```toml
[mcp_servers.zotero_dev]
command = "node"
args = ["/absolute/path/to/zotero-mcp/dist/cli.js"]
env_vars = ["ZOTERO_API_KEY"]
```

Never use a production or write-enabled key in automated tests or CI.

## Acknowledgement

This project was inspired by
[`yilewang/llm-for-zotero`](https://github.com/yilewang/llm-for-zotero).
## License

[MIT](LICENSE)
