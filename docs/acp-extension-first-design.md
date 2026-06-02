# ACP extension-first integration design

Date: 2026-05-30

This design keeps ACP support outside pi base unless a missing primitive is proven. The adapter should first load a small pi extension that exposes ACP-backed services to pi and to other extensions.

## Observed pi extension primitives

The current pi branch already gives extensions enough surface area to attempt most ACP integration outside base:

- `pi.registerTool()` can add or replace LLM-callable tools.
- `pi.on(...)` can observe and intercept session, model, prompt, message, tool, and user bash events.
- `pi.events` is a shared event bus for extension-to-extension messages.
- `ctx.ui` supports select/confirm/input/custom UI. In RPC mode these already surface as `extension_ui_request` events.
- `pi.appendEntry()` can persist custom extension state in the session.
- `pi.exec()` and command handlers can run local processes when a bridge needs helper subprocesses.
- `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools()` can shape tool availability.
- `pi.registerProvider()` can add dynamic providers without base changes.
- Command handlers receive `ExtensionCommandContext.navigateTree()`, which can move the session leaf and rebuild pi's future model context from existing append-only session entries.

## Adapter-owned bridge shape

`pi-acp` should bundle an ACP bridge extension and load it into each pi RPC subprocess. The extension should be narrow and replaceable so it can move into pi base later without changing ACP-facing behavior.

Current startup path:

1. `pi-acp` writes per-session ACP setup data to a temp JSON file: lifecycle, ACP session id, cwd, client capabilities, and MCP server configs.
2. `pi-acp` starts pi RPC with the bundled bridge extension and an env var pointing at that setup file.
3. The bridge extension reads setup during extension load.
4. The bridge extension publishes an `acp:bridge:ready` service object over `pi.events`, answers `acp:bridge:request` with the same service, and emits sanitized lifecycle notices.
5. The bridge extension connects configured stdio MCP servers, lists their tools, registers those tools through `pi.registerTool()`, registers newly listed tools after MCP `notifications/tools/list_changed`, and handles removed tools by deactivating them with `pi.setActiveTools()` plus a disabled fallback stub.
6. The bridge extension registers `/acp-bridge-status` so real pi subprocess tests and users can inspect MCP status and verify registered MCP tools through pi's extension registry without adding pi base RPC methods.
7. Other pi extensions talk to the bridge through `pi.events` service objects/channels and, where needed, registered tools.

Next bridge path:

1. Extend the adapter-owned local JSONL bridge RPC side channel as more extension services need to call back into ACP client methods.
2. Keep adding service object methods behind stable names instead of leaking adapter internals.
3. Keep the event-bus shape usable by independently-authored pi extensions.

This avoids pi base edits while still allowing dynamic calls from pi extension code back to ACP client methods such as filesystem, terminal, permission, and MCP-related service requests.

## Reusable service boundaries

Use event-bus service objects plus JSON-serializable status/event payloads so other extensions can consume the services without importing adapter internals.

The adapter must not add workflow- or vendor-specific ACP methods. Third-party pi extensions can keep their own commands, session entries, and private state, then call the bridge services below to publish standard ACP updates or invoke standard ACP client methods. Custom data remains in `_meta`, and any behavior that cannot be expressed through the stable ACP surface belongs in the extension that owns that workflow.

| Service                             | Owner                         | Initial mechanism                                                                                                                                                                                                                                                                           | ACP behavior                                                                                                                                                        |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP tools/resources                 | Bridge extension              | Connect stdio MCP servers from setup, register resulting tools with `pi.registerTool()`, deactivate removed dynamic tools through `pi.setActiveTools()` plus disabled fallback stubs, expose resource list/read service methods, and provide list/read resource tool shims for near-base pi | Satisfy mandatory stdio MCP support for `session/new`, `session/load`, and `session/resume` without requiring pi base MCP primitives.                               |
| Client filesystem                   | Bridge extension              | Expose read/write service methods, register `acp_read_text_file` and `acp_write_text_file` tool shims for other extensions, shadow `read`/`write`/`edit` when ACP fs capability is present, and delegate to `pi-acp` over bridge RPC                                                        | Use editor/client file state, including unsaved buffers, through `fs/read_text_file` and `fs/write_text_file` without requiring pi base changes.                    |
| Client terminal                     | Bridge extension              | Expose create/output/wait/kill/release service methods, register `acp_terminal_execute`, shadow `bash` when ACP terminal capability is present, and delegate to `pi-acp` over bridge RPC                                                                                                    | Create ACP terminals through the client, emit terminal-backed tool content for adapter-managed terminal results, then release after pi-acp flushes the tool update. |
| Permissions                         | Adapter plus bridge extension | Existing RPC extension UI bridge first; bridge extension can add persisted policy via `pi.appendEntry()`                                                                                                                                                                                    | Support one-shot requests now and later map `allow_always`/`reject_always` to extension-owned policy.                                                               |
| Session metadata/plan               | Bridge extension              | Listen to session/tool/message events and emit bridge events                                                                                                                                                                                                                                | Map titles, plan entries, and status updates when pi or extensions produce structured data.                                                                         |
| Prompt stop reasons/refusal history | Adapter plus bridge extension | Expose `setPromptStopReason("max_turn_requests" \| "refusal")` for other extensions, record the active prompt's safe leaf and user entry, and invoke a private bridge command that calls `navigateTree()` for refusals                                                                      | Return ACP stop reasons produced by pi or extensions and satisfy refusal semantics by excluding the refused user prompt and later branch from future pi context.    |
| Auth/config                         | Adapter plus extension        | Adapter validates ACP methods; adapter-owned logout clears stored `auth.json` only when known non-clearable auth sources are absent; extension can register providers and expose readiness over bridge events                                                                               | Keep terminal auth out-of-band, keep logout capability truthful through capability gates, and allow future provider readiness checks.                               |

## Base fallback triggers

Only move to pi base if one of these proves impossible through extensions:

- The adapter cannot reliably load a bundled extension in RPC mode.
- The extension cannot connect to an adapter-owned local socket or equivalent side channel.
- MCP tools cannot be registered dynamically with enough schema fidelity.
- Removed dynamic MCP tools must disappear from `getAllTools()`/the registry itself, not just from the active tool set with a disabled fallback.
- Built-in read/write/edit/bash tools cannot be disabled, replaced, wrapped, or redirected per ACP session.
- Tool execution events do not carry enough identity/status to map ACP terminal or permission outcomes.
- Session lifecycle events cannot identify startup, resume, close, or replacement boundaries accurately enough.
- Refusal history rollback cannot record the refused user entry or invoke command-context tree navigation reliably in RPC mode.
- Persistent policy cannot be represented with `appendEntry()` or extension-owned session state.
- Adapter-owned mirrored auth-source detection drifts from pi's real auth inventory or cannot account for runtime providers/overrides needed to decide whether `auth.logout` is safe to advertise.

Until one of those is demonstrated, implementation should stay in `pi-acp` plus the bridge extension.
