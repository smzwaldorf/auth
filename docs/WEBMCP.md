# Admin WebMCP

The SMZ Auth admin pages register five browser tools for a connected agent such as Codex. They use the signed-in administrator's session and the existing audited services. No API key or database credential is given to the agent.

## Connect

1. Run the Auth app locally (`npm run dev:auth`) or deploy the change using the normal release process.
2. Open `/admin` and sign in as an administrator. If WebMCP is unavailable, manually enable `chrome://flags/#enable-webmcp-testing` in Chrome and relaunch. Tools register on authenticated admin pages; no separate setup page is needed.
3. Connect Codex to that browser through a tool-capable browser integration. The browser must expose `document.modelContext.registerTool`; ordinary browsers continue to render the existing UI without these tools. Adding this feature to the site does not install a Codex browser connector or create a remote MCP server URL.
4. Ask the agent to discover the `smz_*` tools and start with a search. For example: “Find the family with code F001 and show its current members.” Authorize the concrete changes you want before asking it to save.

For browser-side diagnostics using the current WebMCP API:

```js
const tools = await document.modelContext.getTools();
const search = tools.find(tool => tool.name === "smz_list_records");
await document.modelContext.executeTool(search, { kind: "families", q: "F001" });
```

API reference: https://developer.chrome.com/docs/ai/webmcp/imperative-api

## Tools

| Tool | Purpose |
| --- | --- |
| `smz_navigate` | Open `overview`, `users`, `students`, `families`, or `classes`. `view` is `list` (default), `new`, or `detail` (requires `id`). Opening a creation form does not save a record. Rediscover tools after navigation. |
| `smz_list_records` | Search `users`, `students`, `families`, or `classes`, 25 per page. Optional `role` filters users by `admin`, `teacher`, or `parent`; `total` counts all matches. Returns `directoryVersion`. |
| `smz_get_record` | Read one UUID and its membership records. Adult `version` is the account update timestamp; other `version` values are the directory snapshot hash. |
| `smz_save_user` | Create an adult (omit `id`) or update an adult (include `id` and `version`). Supply the complete desired `displayName`, `email`, `status`, and `roles`. |
| `smz_save_directory` | Create/update students, families, classes and memberships; end memberships or transfer class enrollments, using the existing directory operation schema. |

The authenticated `/admin/webmcp/tools` endpoint returns the full input schemas. The browser adapter posts JSON to `/admin/webmcp/execute/:tool`; this is an internal session-authenticated transport, not an MCP JSON-RPC endpoint.

Read before editing. Pass the returned version without modification. After a successful save, read again to obtain fresh state. A `409` means the change was rejected; review the new state before retrying. Do not automatically repeat a create after a network interruption because the original request may already have committed. Cancellation stops the browser request, but cannot roll back a committed transaction.

For directory creation use `directoryVersion` from a recent search as `version`. Use `kind: "families"` or `"classes"` with `displayName`, `code`, and `status`; students need no code. Omit `id` for creation. Membership operations use `kind: "family-member"` or `"class-member"`, the group's UUID in `groupId`, `personId` or `personIds`, and the appropriate `relationship`. Existing membership edits use their membership `id`. `end-memberships` uses `membershipIds`; `class-transfer` also requires the destination `groupId`. Dates use `YYYY-MM-DD`.

## Access and effects

Every request checks the live session and administrator role. POST requests require the configured issuer Origin and JSON content type; requests retain the existing 16 KiB limit. Writes also recheck access inside the existing transaction and retain audit events, optimistic concurrency, self-protection and development-account protections. No credentials, invitations, OAuth secrets or session tokens are returned by the adult detail tool.

Creating an adult approves their login and gives active approved adults automatic application access; it does not send an invitation email. Updating another adult invalidates their sessions, matching the admin form. Tools describe these effects and mark writes as consequential. There are no hard-delete, mail delivery, OAuth registration, or profile-review tools in this interface.

The adapter is nonce-authorized by the admin page CSP, with fetch limited to the same origin. Tool errors report validation, authorization and conflict failures rather than treating a redirect or HTML error page as a successful save. Record text is untrusted data.

## Verification

`npm run test -w @smz/auth-server` covers authorization, discovery, schema validation, service delegation, concurrency error propagation, CSP injection and adapter behavior using mocked services/browser registration. `npm run typecheck:auth` and `npm run build:auth` verify TypeScript compilation. These checks do not establish native browser/connector compatibility or real database write behavior; verify those in a controlled local/staging environment before relying on a production agent workflow.

## Navigation and user creation

In Codex's in-app browser, discover the page's WebMCP tools and call `smz_navigate` with `{ "destination": "users", "view": "new" }` to display the new-user form. Navigation uses fixed admin routes, never arbitrary URLs, and leaves the current page, so finish any unsaved edits first.

For direct creation, call `smz_save_user` with the authorized display name, email, status and complete roles array, omitting `id`. Read the returned user with `smz_get_record`, then call `smz_navigate` with `{ "destination": "users", "view": "detail", "id": "<returned UUID>" }` to show it. This creates an approved login account; active accounts gain access and no email is sent. Search by email before creating, and check existing records after an ambiguous response instead of repeating the create.
