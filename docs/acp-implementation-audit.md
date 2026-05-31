# ACP implementation audit for pi

Date: 2026-05-30

This is a planning artifact, not an implementation change. It inventories ACP v1, compares it to the current `pi-acp` adapter, identifies changes that belong in `pi-acp` versus `pi`, and proposes a test strategy for driving full conformance.

## Scope and sources

Stable protocol target:

- ACP stable protocol version: `1`
- Official docs inspected from `agentclientprotocol/agent-client-protocol` at `bbeed28`
- Official schema files inspected: `schema/meta.json`, `schema/schema.json`
- Protocol docs inspected: architecture, agents, initialization, transports, session setup, session list, prompt turn, content, tool calls, file system, terminals, session config options, session modes, slash commands, auth, agent plan, extensibility
- Architecture notes that an ACP connection can support several concurrent sessions and that editors commonly pass MCP server configs to agents.
- Agent/client registry pages list Zed, JetBrains, VS Code ACP, Neovim plugins, Codex CLI via adapter, Gemini CLI, Goose, OpenCode, Cursor, Copilot CLI, and pi via `pi-acp`, among others.

Code and implementation sources inspected:

- `pi-acp` at `138edb0`, branch `acp`
- `pi` at `dbb9911a`, branch `acp`
- ACP TypeScript SDK at `c6a9c94`
- ACP Python SDK at `8cd8391`
- ACP Rust SDK at `2e8c815`
- Gascity ACP runtime/conformance pattern at `8675c240`
- `pi-acp` dependency `@agentclientprotocol/sdk` was upgraded to `0.22.1` during this work; `npm view` reported `0.22.1` as latest on 2026-05-30.

Out of scope for this pass:

- ACP v2/draft or RFD-only features unless they affect design direction
- Implementation code changes
- PR merge decisions for existing upstream work

## Executive assessment

`pi-acp` is a useful first-pass MVP and worth building on. It now implements the stable ACP v1 checklist in `test/conformance/acp-v1-checklist.json`: 81 entries are implemented and 4 optional surfaces are intentionally not advertised (`audio`, HTTP MCP, and SSE MCP). It uses the official TypeScript SDK, speaks stdio NDJSON, wraps pi's RPC mode, handles initialization, `authenticate`, `logout`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/resume`, `session/close`, session listing, model/thinking config options, prompt content conversion, streaming text/thought updates, tool call updates, edit diffs, slash command advertisement, terminal auth entrypoint, and persistence mapping.

The remaining work is fidelity hardening around optional or pi-native UX, not an uncovered stable ACP v1 surface:

- ACP says all agents must support stdio MCP servers passed in session setup. `pi-acp` now accepts `mcpServers`, forwards them into a bundled ACP bridge extension setup/service for `session/new`, `session/load`, and `session/resume`, connects stdio MCP servers, registers listed MCP tools with pi through the extension API, exposes MCP resource list/read service methods and near-base pi list/read resource tool shims, preserves MCP tool-result resource links and embedded resource content in pi-visible tool output, registers newly listed tools after MCP `notifications/tools/list_changed`, and deactivates removed MCP tools while keeping disabled stubs as a registry fallback because pi's extension API has no unregister primitive. Opt-in real pi subprocess E2E covers successful tool registration, failed setup visibility, active-session MCP isolation, and load/resume lifecycle setup; MCP resource service/tool-shim coverage is currently unit-level. Remaining MCP risks are registry-level unregister if clients require removed tools to disappear from `getAllTools()`, native resource UX if tool shims are insufficient, and broader visible per-session error surfacing. These are pi fidelity risks, not blockers for the stable stdio MCP setup requirement.
- `pi-acp` no longer proactively closes peer sessions during `session/new` or `session/load`; unit/component coverage now exercises independent active sessions, close, load/resume, and prompt queues, but more real-client concurrency smoke coverage would still be useful.
- `session/close`, `session/resume`, and `session/set_config_option` now have adapter implementations. `session/resume` validates absolute `cwd`, preserves no-replay semantics, forwards MCP setup for cold resumes, and rejects active-session resumes whose requested `cwd` does not match the immutable active session cwd. `logout` is implemented for pi's stored `auth.json` credentials and is capability-gated: `auth.logout` is advertised only when pi-acp detects no environment or `models.json` auth source that would survive logout.
- Client-side filesystem delegation now exists as an extension-owned bridge RPC service and near-base pi tool shims (`acp_read_text_file`, `acp_write_text_file`) when the ACP client advertises fs capabilities. In fs-capable sessions the bridge extension also shadows `read`, `write`, and `edit` with ACP-client-backed tools, so normal pi file tool calls can use editor-owned unsaved buffer state without pi base changes. Client terminal delegation now has the same extension-owned shape: the bridge service exposes terminal lifecycle methods and an `acp_terminal_execute` shim when `clientCapabilities.terminal` is advertised. In terminal-capable sessions the bridge extension also shadows `bash` with a terminal-backed extension tool; pi-acp emits `terminal` tool content for those adapter-managed terminal results and releases the terminal after the update flushes. Permission bridging covers pi extension UI select/confirm requests and configured sensitive pi `tool_call` preflights through ACP `session/request_permission`, including session-local allow/reject-always policy.
- ACP plan updates are now available as an extension-owned service boundary: the bundled bridge extension exposes `publishPlan(entries)` so independently authored pi extensions can publish complete ACP `plan` updates without pi base changes. There is still no native pi plan-event mapping because near-base pi does not currently expose a built-in plan concept. Prompt stop reasons have the same extension-owned escape hatch for non-native conditions: `setPromptStopReason("max_turn_requests" | "refusal")` can drive the actual ACP `session/prompt` response, while future pi-native `stopReason` values enter the same mapping path. For `refusal`, the adapter now invokes a bundled bridge command that uses pi's command-context `navigateTree()` to move the session leaf back before the refused user message, so future pi context excludes the refused prompt and everything after it without editing pi base. If that rollback cannot be proven, pi-acp downgrades the public stop reason to `end_turn` rather than returning a misleading ACP refusal.
- Stable `configOptions` are now exposed for model and thought-level selection. Adapter-owned model state has moved under `_meta.piAcp.models`; complete `config_option_update` notifications are emitted for ACP-driven config changes and pi `model_update`/`thinking_level_update` events. Legacy `modes` remains as a documented transitional session response field and still needs a client-compatibility retirement plan.
- The ACP TypeScript SDK includes current stable `logout`, `session/close`, `session/resume`, and `session/set_config_option`, but also includes compatibility/unstable surfaces such as `session/fork`, document notifications, providers, NES, and MCP-over-ACP. `session/set_model` is intentionally served as a compatibility alias for model config selection. Stable v1 conformance should therefore be driven by the frozen official inventory in `test/conformance/acp-v1-meta.json`, with extra SDK surfaces treated separately.
- pi base RPC has useful hooks that `pi-acp` does not expose yet, but full ACP support for MCP and client-delegated fs/terminal behavior should first be attempted through reusable pi extension services, with pi base changes only as a proven fallback.

Recommendation: build on `pi-acp` as the adapter layer, but treat it as a protocol adapter plus conformance target, not as the final ACP architecture. Avoid moving ACP directly into pi base for now. Add pi RPC hooks only where adapter-only work cannot satisfy the spec.

## Architecture constraint: extension-first

The preferred implementation strategy is extension-first:

- Keep ACP support in `pi-acp` and pi extensions wherever possible.
- Treat pi base changes as the last resort, not the default path.
- Even if an extension-based solution is ugly, prefer it when it can satisfy ACP behavior without weakening correctness.
- Write the extension implementation behind narrow interfaces so it can move into pi base later without changing ACP-facing behavior.
- Assume a near-base pi installation with minimal built-in ACP support. The adapter should provide a reusable place for pi extensions to register or consume ACP-facing services for their own needs.
- Any capability that appears to require pi base work should first get an extension design: what hook/event/service is needed, how other extensions can use it, and what exact missing primitive would force a base change.

This changes how to read "requires pi base" below: those items are not permission to edit pi base immediately. They are places where current pi extension/RPC surfaces may be insufficient; the next step is to try an extension-owned service boundary first.

The concrete bridge proposal is in `docs/acp-extension-first-design.md`.

## ACP v1 protocol inventory

### Agent methods

These are JSON-RPC requests or notifications sent by the Client to the Agent.

| Method                      | Kind         | Capability gate                                | Required fields                                                         | Required behavior                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------ | ---------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                | request      | Always required before sessions                | `protocolVersion`; optional `clientCapabilities`, `clientInfo`, `_meta` | Client MUST call before session setup. Agent MUST negotiate protocol version. If requested version is supported, return it; otherwise return latest supported. Agent MUST advertise supported capabilities and SHOULD return `agentInfo` and `authMethods`. Omitted capabilities mean unsupported. |
| `authenticate`              | request      | Use advertised `authMethods`                   | `methodId`                                                              | Agent should authenticate using a method advertised by `initialize`. On success returns `{}`. Authentication-gated session requests may return ACP auth-required error until this succeeds.                                                                                                        |
| `logout`                    | request      | `agentCapabilities.auth.logout`                | none                                                                    | Client MUST NOT call unless advertised. Agent ends current authenticated state and returns `{}`. Existing active sessions may continue, terminate, or later fail with auth errors.                                                                                                                 |
| `session/new`               | request      | Baseline method                                | `cwd`, `mcpServers`                                                     | Client MUST initialize first. `cwd` MUST be absolute and MUST be used regardless of agent subprocess cwd. Agent MUST return a unique `sessionId`. Agent SHOULD connect to supplied MCP servers; all agents MUST support stdio MCP transport. Response MAY include `modes` and/or `configOptions`.  |
| `session/load`              | request      | `agentCapabilities.loadSession`                | `sessionId`, `cwd`, `mcpServers`                                        | Client MUST verify capability first. Agent restores session, connects MCP servers, MUST replay entire conversation via `session/update` notifications before responding. Response MAY include `modes` and/or `configOptions`.                                                                      |
| `session/resume`            | request      | `agentCapabilities.sessionCapabilities.resume` | `sessionId`, `cwd`; schema makes `mcpServers` optional                  | Client MUST verify capability first. Agent reconnects/restores without replaying history and returns once ready. Response MAY include `modes` and/or `configOptions`.                                                                                                                              |
| `session/close`             | request      | `agentCapabilities.sessionCapabilities.close`  | `sessionId`                                                             | Client MUST verify capability first. Agent MUST cancel ongoing work for the session as if `session/cancel` happened, then free session resources. Returns `{}`.                                                                                                                                    |
| `session/list`              | request      | `agentCapabilities.sessionCapabilities.list`   | optional `cwd`, `cursor`                                                | Client MUST verify capability first. `cwd`, if present, must be absolute. Agent returns `sessions: []` and optional `nextCursor`. Missing `nextCursor` means end. Cursor is opaque. Invalid cursor SHOULD error. Reasonable internal page sizes expected.                                          |
| `session/prompt`            | request      | Baseline method                                | `sessionId`, `prompt`                                                   | Client MUST initialize and set up a session first. Prompt is `ContentBlock[]`. Client MUST restrict prompt content to agent prompt capabilities. Agent streams updates via `session/update` and MUST eventually respond with `stopReason`.                                                         |
| `session/cancel`            | notification | Baseline method                                | `sessionId`                                                             | Agent cancels ongoing turn for the session. The active `session/prompt` response MUST be `stopReason: "cancelled"`, even if lower layers throw cancellation errors.                                                                                                                                |
| `session/set_mode`          | request      | Session response advertises `modes`            | `sessionId`, `modeId`                                                   | Legacy mode API. Agent changes mode at any time and may also emit `current_mode_update`. If config options also exist, keep mode-like state in sync.                                                                                                                                               |
| `session/set_config_option` | request      | Session response advertises `configOptions`    | `sessionId`, `configId`, `value`                                        | Preferred session configuration API. Agent MUST return complete `configOptions` state after every change. Values must be known values for that option.                                                                                                                                             |

### Client methods

These are JSON-RPC requests or notifications sent by the Agent to the Client.

| Method                       | Kind         | Capability gate                                          | Required fields                                                          | Required behavior                                                                                                                                                                                                                            |
| ---------------------------- | ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/update`             | notification | Baseline notification                                    | `sessionId`, `update`                                                    | Agent sends all conversation, tool, plan, command, mode, config, and session metadata updates through this notification.                                                                                                                     |
| `session/request_permission` | request      | No explicit client capability; agent may use when needed | `sessionId`, `toolCall`, `options`                                       | Agent asks user/client to approve sensitive tool execution. Client returns `outcome.selected` with `optionId` or `outcome.cancelled`. If the prompt turn is cancelled while permission is pending, Client MUST respond with `cancelled`.     |
| `fs/read_text_file`          | request      | `clientCapabilities.fs.readTextFile`                     | `sessionId`, `path`; optional `line`, `limit`                            | Agent MUST NOT call unless client advertised support. Path must be absolute. Reads editor/client text file content, including unsaved editor state.                                                                                          |
| `fs/write_text_file`         | request      | `clientCapabilities.fs.writeTextFile`                    | `sessionId`, `path`, `content`                                           | Agent MUST NOT call unless client advertised support. Path must be absolute. Client MUST create file if missing. Returns empty result on success.                                                                                            |
| `terminal/create`            | request      | `clientCapabilities.terminal`                            | `sessionId`, `command`; optional `args`, `env`, `cwd`, `outputByteLimit` | Agent MUST NOT call unless client advertised terminal support. Creates command and returns `terminalId` immediately. `cwd`, if present, must be absolute. Output byte limit truncates from beginning and MUST preserve character boundaries. |
| `terminal/output`            | request      | `clientCapabilities.terminal`                            | `sessionId`, `terminalId`                                                | Returns current `output`, required `truncated`, and optional `exitStatus`.                                                                                                                                                                   |
| `terminal/wait_for_exit`     | request      | `clientCapabilities.terminal`                            | `sessionId`, `terminalId`                                                | Returns when terminal exits, with nullable `exitCode` and `signal`.                                                                                                                                                                          |
| `terminal/kill`              | request      | `clientCapabilities.terminal`                            | `sessionId`, `terminalId`                                                | Terminates command but does not release terminal. Agent still must release later.                                                                                                                                                            |
| `terminal/release`           | request      | `clientCapabilities.terminal`                            | `sessionId`, `terminalId`                                                | Kills if still running, releases resources, and invalidates terminal id. Client SHOULD keep displaying terminal output if embedded in a tool call.                                                                                           |

### Session update variants

All are sent via `session/update`.

| `sessionUpdate`             | Payload requirements                                                                              | Notes                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message_chunk`        | `content: ContentBlock`                                                                           | Used when replaying or streaming user content.                                                                                                                                  |
| `agent_message_chunk`       | `content: ContentBlock`                                                                           | Used for assistant-visible response content.                                                                                                                                    |
| `agent_thought_chunk`       | `content: ContentBlock`                                                                           | Used for internal reasoning/thought stream.                                                                                                                                     |
| `tool_call`                 | `toolCallId`, `title`; optional `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput` | Agent SHOULD report tool calls when created. `toolCallId` is unique within the session.                                                                                         |
| `tool_call_update`          | `toolCallId`; optional replacement fields                                                         | Agent reports status/progress/results. All fields except `toolCallId` are optional.                                                                                             |
| `plan`                      | complete `entries[]` with `content`, `priority`, `status`                                         | Every plan update MUST contain the complete plan. Client MUST replace the current plan.                                                                                         |
| `available_commands_update` | `availableCommands[]`                                                                             | Agent may advertise slash commands; commands are invoked through ordinary `session/prompt` text.                                                                                |
| `current_mode_update`       | `currentModeId`                                                                                   | Agent may update mode state. The prose docs currently show `modeId` in one example, but the stable schema requires `currentModeId`; conformance tests should follow the schema. |
| `config_option_update`      | complete `configOptions[]`                                                                        | Every update MUST include complete config state.                                                                                                                                |
| `session_info_update`       | optional `title`, `updatedAt`, `_meta`                                                            | Must not include `sessionId` or `cwd`; `sessionId` is in params and `cwd` is immutable. Fields are partial updates.                                                             |

### Content blocks

| Type            | Required fields                                                    | Prompt support requirement                                                                         |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `text`          | `text`                                                             | All agents MUST support in prompts. Clients SHOULD render as Markdown.                             |
| `resource_link` | `uri`, `name`; optional `title`, `description`, `mimeType`, `size` | All agents MUST support in prompts. Represents resource the agent can access.                      |
| `image`         | `data`, `mimeType`; optional `uri`                                 | Requires `promptCapabilities.image`.                                                               |
| `audio`         | `data`, `mimeType`                                                 | Requires `promptCapabilities.audio`.                                                               |
| `resource`      | `resource` with text or blob contents                              | Requires `promptCapabilities.embeddedContext`. Preferred for file/context mentions when available. |

### Tool calls

Tool call statuses:

- `pending`
- `in_progress`
- `completed`
- `failed`

Tool kinds:

- `read`
- `edit`
- `delete`
- `move`
- `search`
- `execute`
- `think`
- `fetch`
- `switch_mode`
- `other`

Tool call content:

- `content`: wraps a normal `ContentBlock`
- `diff`: absolute `path`, optional nullable `oldText`, required `newText`
- `terminal`: `terminalId` for a terminal created through `terminal/create`

Tool locations:

- `path` is required and must be absolute
- `line` is optional

Permission options:

- Each option needs `optionId`, `name`, and `kind`
- `kind` is one of `allow_once`, `allow_always`, `reject_once`, `reject_always`
- Permission outcomes are `selected` with `optionId`, or `cancelled`

### Session configuration and modes

`configOptions` are preferred over `modes`.

Config option requirements:

- Agent MAY return `configOptions` from `session/new`, `session/load`, or `session/resume`.
- Currently stable option type is `select`.
- Every option needs `id`, `name`, `type`, `currentValue`, and `options`.
- Every option MUST have a default/current value.
- Agent SHOULD order options by display priority.
- Categories are UX hints only. Known categories are `mode`, `model`, `thought_level`; unknown categories must not be required for correctness.
- `session/set_config_option` MUST return the complete config state.
- `config_option_update` MUST contain the complete config state.
- If a mode-like config option and legacy `modes` are both provided, they SHOULD be kept in sync.

Mode requirements:

- Session response MAY include `modes.currentModeId` and `modes.availableModes`.
- `session/set_mode` changes current mode and returns `{}`.
- Agent may send `current_mode_update`.
- Modes are transitional and expected to be removed in a future protocol version.

### MCP servers

MCP server configs are passed to `session/new`, `session/load`, and `session/resume`.

Transport support:

- Stdio MCP support is mandatory for all agents.
- HTTP MCP support is optional and must be advertised with `mcpCapabilities.http`.
- SSE MCP support is optional, deprecated by MCP, and must be advertised with `mcpCapabilities.sse`.
- Clients MUST verify HTTP/SSE capability before sending those transports.
- Agents SHOULD connect to all MCP servers specified by the Client.

Stdio MCP schema:

- `name`, `command`, `args`, `env`
- Docs say command should be absolute.

HTTP/SSE schema:

- `type`, `name`, `url`, `headers`

### Transport, schema, and extensibility requirements

- JSON-RPC messages MUST be UTF-8.
- Stdio transport messages are newline-delimited JSON and MUST NOT contain embedded newlines.
- Agent MUST NOT write non-ACP data to stdout.
- Client MUST NOT write non-ACP data to stdin.
- Stderr may be used for logs.
- All file paths in protocol data MUST be absolute unless a specific field says otherwise.
- JSON object keys are camelCase.
- Discriminator string values are snake_case.
- Every protocol type supports `_meta`.
- Implementations MUST NOT add custom root-level fields to protocol-defined types. Use `_meta` instead.
- Custom methods and notifications MUST start with `_`.
- Unrecognized custom notifications SHOULD be ignored.
- Unrecognized custom requests should return JSON-RPC method-not-found.
- Custom capabilities SHOULD be advertised in `_meta`.

### Error codes

ACP uses standard JSON-RPC errors plus protocol-specific codes:

- `-32700`: parse error
- `-32600`: invalid request
- `-32601`: method not found
- `-32602`: invalid params
- `-32603`: internal error
- `-32000`: authentication required
- `-32002`: resource not found

Error objects require `code` and `message`, with optional `data`.

## Current `pi-acp` coverage

### Implemented or mostly implemented

| ACP area                      | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stdio NDJSON adapter          | Uses official SDK `AgentSideConnection` and `ndJsonStream`; guards stdout shutdown and has subprocess fixtures for malformed/chunked initialize input plus protocol-only stdout through `session/new` and a prompt turn with a noisy spawned pi process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/index.ts`, `test/conformance/acp-stdio-e2e.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `initialize`                  | Negotiates v1 and returns `agentInfo`, auth methods, load/session list, prompt/MCP capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/acp/agent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `authenticate`                | Advertises terminal auth only to SDK-capable clients (`clientCapabilities.auth.terminal`) or legacy Zed clients using `_meta["terminal-auth"]`, validates advertised method ids, then runs a short pi RPC model-availability probe before returning success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/acp/agent.ts`, `src/acp/auth.ts`, `test/unit/authenticate.test.ts`, `test/unit/auth-methods-terminal-auth-meta.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                |
| `session/new`                 | Validates absolute `cwd`, starts pi RPC, returns session id, stable `configOptions`, legacy `modes`, adapter model state under `_meta.piAcp.models`, and sends available commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/acp/agent.ts`, `src/acp/session.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session/prompt`              | Converts ACP prompt blocks, runs pi prompt, streams pi events to ACP updates, surfaces prompt failures as visible text updates, returns stop reason, maps pi `length` completions to ACP `max_tokens`, maps future pi-native `max_turn_requests`, routes pi-native and extension-owned `refusal` through rollback, exposes extension-owned stop-reason override service for externally enforced turn limits/refusals, and restores the ACP refusal history boundary through the bridge extension before resolving refusal prompts                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/acp/agent.ts`, `src/acp/session.ts`, `src/acp/client-stop-reasons.ts`, `src/acp/refusal-history.ts`, `src/acp/translate/prompt.ts`, `test/component/session-events.test.ts`, `test/component/session-client-bridge-prompt-turn.test.ts`, `test/conformance/acp-runtime-schema.test.ts`, `test/conformance/acp-stdio-e2e.test.ts`                                                                                                                                                                                       |
| `session/cancel`              | Calls pi `abort`; resolves active or queued turns as cancelled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `src/acp/agent.ts`, `src/acp/session.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session/load`                | Loads known pi session file, replays history as `session/update` before responding, preserves ACP-compatible text/resource_link/image/resource content blocks, reconstructs historic tool calls from assistant tool-call blocks when present, falls back to synthetic calls for older result-only rows, returns stable `configOptions`, legacy `modes`, and adapter model state under `_meta.piAcp.models`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/acp/agent.ts`, `src/acp/translate/pi-messages.ts`, `test/component/session-load-toolresult.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session/resume`              | Attaches without replaying history, validates absolute `cwd`, rejects active-session cwd mismatches, forwards supplied `mcpServers` into bridge setup for cold resumes, and returns stable `configOptions`, legacy `modes`, and adapter model state under `_meta.piAcp.models`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `src/acp/agent.ts`, `test/component/session-list-and-load.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session/list`                | Implemented through stable `listSessions`; keeps legacy `unstable_listSessions` alias; validates cwd/cursor and returns sessions with opaque cursor pagination and cwd filtering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/acp/agent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session/close`               | Cancels active work best-effort, disposes the pi subprocess, and removes the active adapter session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/acp/agent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session/set_mode`            | Maps mode id to pi thinking level and emits a mode update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/acp/agent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session/set_config_option`   | Supports stable `model` and `thought_level` selectors and returns the complete config state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/acp/agent.ts`, `test/component/session-thinking-modes.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `config_option_update`        | Emits complete config state when ACP config setters mutate adapter-owned configuration and when pi emits `model_update` or `thinking_level_update` events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/acp/agent.ts`, `src/acp/session.ts`, `src/acp/config-options.ts`, `test/component/session-thinking-modes.test.ts`, `test/component/session-events.test.ts`                                                                                                                                                                                                                                                                                                                                                             |
| `session/request_permission`  | Bridges pi RPC `extension_ui_request` select/confirm events through ACP permission requests and sends `extension_ui_response` back to pi; confirm prompts include allow/reject-always options with a session-local policy cache, and pending UI requests are cancelled on `session/cancel`. The bridge extension also preflights configured sensitive pi `tool_call` events through an adapter-owned `permission/request_tool_call` RPC method and returns pi `{ block: true }` results for rejected or cancelled ACP outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/acp/session.ts`, `src/acp/client-permissions.ts`, `src/acp/client-bridge.ts`, `src/pi-rpc/process.ts`, `src/pi-extension/acp-bridge.ts`, `test/component/session-permissions.test.ts`, `test/unit/client-permissions-bridge.test.ts`, `test/unit/pi-extension-acp-bridge.test.ts`                                                                                                                                                                                                                                      |
| ACP bridge extension scaffold | Bundles and loads an ACP bridge extension, writes per-session setup with lifecycle, cwd, session id, MCP server configs, and client capabilities, exposes a reusable `pi.events` service for other extensions, registers stdio MCP tools through pi's extension API, exposes MCP resource list/read service methods plus resource list/read tool shims, exposes prompt resource list/read service methods plus prompt resource tool shims, opens adapter bridge RPC for ACP client fs calls, registers ACP read/write file shims when advertised, shadows `read`/`write`/`edit` through the ACP client fs when advertised, handles dynamic MCP tool additions/resource refreshes and removals through active-tool deactivation plus disabled fallback stubs, and includes opt-in real pi subprocess E2E coverage for MCP tool registration, failure status, active-session isolation, load/resume lifecycle setup, and file/terminal tool shadowing | `src/pi-rpc/bridge-extension.ts`, `src/pi-rpc/bridge-rpc.ts`, `src/pi-rpc/process.ts`, `src/acp/client-fs.ts`, `src/acp/prompt-resources.ts`, `src/pi-extension/acp-bridge.ts`, `src/pi-extension/mcp-stdio.ts`, `test/component/bridge-extension-setup.test.ts`, `test/component/session-list-and-load.test.ts`, `test/unit/client-fs-bridge.test.ts`, `test/unit/pi-rpc-bridge-extension.test.ts`, `test/unit/pi-extension-acp-bridge.test.ts`, `test/unit/mcp-stdio-bridge.test.ts`, `test/e2e/pi-subprocess-mcp.e2e.ts` |
| Slash commands                | Emits `available_commands_update` after session setup and supports adapter-side built-ins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/acp/agent.ts`, `src/acp/slash-commands.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Text/thought streaming        | Maps pi `text_delta` and `thinking_delta` to `agent_message_chunk` and `agent_thought_chunk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `src/acp/session.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Agent plan                    | Exposes bridge-extension `publishPlan(entries)` service for other pi extensions and forwards complete ACP `plan` session updates through adapter RPC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/acp/client-plan.ts`, `src/acp/client-bridge.ts`, `src/pi-extension/acp-bridge.ts`, `test/unit/client-plan-bridge.test.ts`, `test/unit/pi-extension-acp-bridge.test.ts`, `test/conformance/acp-runtime-schema.test.ts`                                                                                                                                                                                                                                                                                                  |
| Tool calls                    | Maps pi tool call lifecycle to `tool_call` and `tool_call_update` with ids, shared stable kinds for live and loaded history (`read`, `edit`, search/delete/move/fetch/think/switch-mode-like tools, and `bash`/terminal-backed `execute`), monotonic statuses, locations, raw input/output, failed output content, and adapter-managed terminal content policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `src/acp/session.ts`, `src/acp/tool-kind.ts`, `src/acp/agent.ts`, `test/component/session-events.test.ts`, `test/component/session-load-toolresult.test.ts`                                                                                                                                                                                                                                                                                                                                                                 |
| Edit diffs                    | Captures pre-edit snapshots and emits ACP `diff` content only with absolute paths; adapter-managed ACP client fs write/edit results can provide old/new text directly without reading local disk, nullable `oldText` is preserved for new files, unchanged or relative-path results fall back to text content, and deterministic prompt-turn coverage exercises the bridge extension's shadowed multi-edit tool through adapter RPC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/acp/session.ts`, `src/pi-extension/acp-bridge.ts`, `test/component/session-diff.test.ts`, `test/component/session-client-bridge-prompt-turn.test.ts`                                                                                                                                                                                                                                                                                                                                                                   |
| Session metadata              | `/name` emits `session_info_update`; current code includes recent title support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/acp/agent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Prompt content                | Text and resource links are baseline; resource links are preserved as pi-visible context hints and exposed through an extension-owned prompt resource service/tool shim that reads file, `data:`, and fetchable `http(s)` URIs; image is advertised and translated to pi image attachments; audio is unadvertised and rejected at the prompt boundary; embedded resources are accepted only when `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertised `promptCapabilities.embeddedContext`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/acp/agent.ts`, `src/acp/translate/prompt.ts`, `src/acp/prompt-resources.ts`, `test/unit/prompt-resources.test.ts`, `test/component/session-prompt-capabilities.test.ts`                                                                                                                                                                                                                                                                                                                                                |
| Existing test base            | Unit/component/conformance tests cover the stable ACP v1 adapter surface; last full run passed 181/181 on 2026-05-30; conformance checklist passed 14/14; opt-in real pi MCP/bridge E2E passed 7/7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `test/**`, `test/e2e/**/*.e2e.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Residual Risks

| ACP area                    | Current gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why it matters                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP registry/resource UX    | The bundled bridge extension can launch stdio MCP servers, list tools, register MCP tools with pi, expose MCP resource list/read service methods and list/read tool shims, preserve MCP tool-result resource links and embedded resource content in pi-visible tool output, register newly listed tools and refresh resource lists after MCP list-changed notifications, deactivate removed tools and keep disabled fallback stubs, and opt-in real pi subprocess E2E verifies successful tool registration, failed setup status, resource list/read service access, active-session isolation, and load/resume lifecycle setup | Stable ACP v1 stdio MCP setup is implemented. Remaining risk is pi/client UX fidelity: removed tools still exist in `getAllTools()` until pi exposes registry-level unregister, and native resource browsing may be better than tool shims for some clients.                                                                                                        |
| Client fs delegation        | The bundled bridge now opens an adapter-owned bridge RPC side channel when ACP fs capabilities are advertised, exposes read/write text file service methods to other extensions, registers `acp_read_text_file`/`acp_write_text_file` shims, and shadows `read`/`write`/`edit` so normal pi file tools call ACP `fs/read_text_file` and `fs/write_text_file` when advertised                                                                                                                                                                                                                                                   | ACP client fs is how agents can see editor-owned unsaved buffer state. This is now transparent for the core pi file tools in fs-capable sessions, with deterministic prompt-turn coverage through the real adapter bridge handler, including multi-edit diff emission. Remaining risk is real-provider tool-selection behavior.                                     |
| Multiple active sessions    | `session/new`, `session/load`, and `session/resume` no longer close peer sessions. Existing tests cover scoped listing, active-session cwd matching, explicit close, prompt queues, and load/resume, but more real-client concurrency smoke coverage would strengthen confidence                                                                                                                                                                                                                                                                                                                                               | ACP treats sessions as independent; clients may keep multiple sessions active or close explicitly.                                                                                                                                                                                                                                                                  |
| `session/load` replay drift | Replays ACP-compatible user/assistant text, resource links, images, audio, embedded resources, assistant tool-call inputs, and synthetic fallback tool calls; unit/component tests assert structured content replay order before the `session/load` response resolves                                                                                                                                                                                                                                                                                                                                                          | Remaining risk is future pi history shape drift; keep component fixtures aligned with real `get_messages` output.                                                                                                                                                                                                                                                   |
| Config option cleanup       | Stable `configOptions` are available, root-level `models` has moved to `_meta.piAcp.models`, and pi model/thought update events now produce complete `config_option_update` notifications, but legacy `modes` remains in session responses                                                                                                                                                                                                                                                                                                                                                                                     | Clients should prefer `configOptions`, and stable ACP conformance should eventually stop relying on the transitional legacy mode API.                                                                                                                                                                                                                               |
| Prompt stop reasons         | Prompt failures emit a visible `agent_message_chunk` and resolve internally as `"error"`; public stable ACP responses still map non-cancelled errors to `end_turn`. pi assistant `stopReason: "length"` maps to ACP `max_tokens`; future pi-native `max_turn_requests` maps directly; pi-native and extension-owned `refusal` values invoke the bundled bridge command `/acp-restore-refusal-history`, which navigates the session tree to the refused user message so pi sets the future-context leaf to that message's parent.                                                                                               | ACP has no error stop reason. Visible error text preserves client feedback while keeping the wire response schema-compatible. Refusal rollback is extension-owned in the default bridge path; if rollback is unavailable or fails, pi-acp returns `end_turn` instead of claiming refusal semantics.                                                                 |
| Prompt concurrency          | Additional prompts are adapter-queued and surfaced as text/session meta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pi RPC supports steering/follow-up. ACP does not currently have stable mid-turn injection, but user experience and issue #7 point to mapping to pi steering/follow-up.                                                                                                                                                                                              |
| Client terminal delegation  | The bundled bridge now opens the same adapter-owned bridge RPC side channel when ACP terminal capability is advertised, exposes terminal create/output/wait/kill/release service methods to other extensions, registers `acp_terminal_execute`, and shadows `bash` with a terminal-backed extension tool                                                                                                                                                                                                                                                                                                                       | Usable as an extension-owned primitive. Adapter-managed terminal results now emit ACP terminal tool content and release after the update flushes, with deterministic prompt-turn coverage through the real adapter bridge handler. Timeout/abort interruptions now kill client terminals and interrupted prompt-turn results are still released after update flush. |
| Bash tool rendering         | `bash` is reported as ACP `execute` for both live events and loaded history. In terminal-capable sessions the extension still backs `bash` with ACP terminals and emits terminal tool content; local built-in bash uses the same semantic kind with text output content                                                                                                                                                                                                                                                                                                                                                        | This keeps the richer client-terminal path while making the non-terminal path semantically conformant. PR #31 explored the terminal rendering side.                                                                                                                                                                                                                 |
| Resource link semantics     | Resource links still become a textual `[Context] uri` hint, but the adapter now also exposes active-turn links through an extension-owned prompt resource service and tool shims; `file://` links read via ACP client fs when advertised, or local fs as fallback, while `data:` and fetchable `http(s)` links are read directly with a size cap                                                                                                                                                                                                                                                                               | ACP says resource link means agent can access that resource. This is now an extension-owned implementation without base pi changes; remaining risk is native client resource UX or real-provider tool selection if tool shims are insufficient.                                                                                                                     |
| Embedded context            | Implemented behind `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`; disabled sessions reject embedded resources at the prompt boundary, and enabled sessions accept text/blob embedded resources as prompt context markers                                                                                                                                                                                                                                                                                                                                                                                                               | There is no adapter-owned token/size limit yet; add one only if pi exposes a concrete limit or UX issue.                                                                                                                                                                                                                                                            |
| Authentication              | Terminal auth is out-of-band, but `authenticate` now validates method ids and proves readiness by spawning a short pi RPC probe and requiring at least one available model. Terminal auth is capability-gated on `clientCapabilities.auth.terminal` or legacy Zed `_meta["terminal-auth"]`, and auth-required errors reuse the negotiated method set. `logout` clears pi's stored `auth.json` credentials, reports removed provider ids in `_meta.piAcp`, and omits `auth.logout` when known environment or `models.json` auth sources would survive logout.                                                                   | Works for current Zed-style flow. The authenticate probe has no ACP cwd parameter, so it uses the most recent ACP session cwd or the adapter cwd; revisit if ACP adds cwd-scoped auth. Logout relies on pi-acp's mirrored inventory of pi auth sources; a pi-owned auth inventory hook would be stronger and less likely to drift.                                  |
| Permission policy           | Permission bridge supports one-shot allow/reject options for extension UI requests and session-local `allow_always`/`reject_always` caching for matching confirm prompts                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ACP supports policy-style option kinds. This is now adapter-owned for extension confirms; durable cross-session policy should wait for a safe pi/extension persistence primitive.                                                                                                                                                                                   |

### Future Hardening

| ACP area                                           | Follow-up                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full provider logout                               | Stored-auth logout is adapter-owned and capability-gated against known environment and `models.json` auth sources. A pi-owned auth inventory/logout hook is still the preferred replacement for pi-acp's mirrored source detection, especially for future auth sources and runtime overrides.                                                                                            |
| Native pi plan events                              | ACP `plan` updates can be published by extensions through `publishPlan(entries)`, but near-base pi does not currently emit a built-in plan event to map automatically.                                                                                                                                                                                                                   |
| Real-provider long-running terminal behavior       | Terminal-backed `bash` and `acp_terminal_execute` are covered at unit/component level, deterministic prompt-turn harness level, and pi subprocess registry/source E2E. Timeout/abort kill paths and interrupted-result release ordering are covered without pi base changes. Remaining risk is real-provider long-running command behavior once a deterministic provider harness exists. |
| MCP native resources and registry-level unregister | Stable stdio MCP setup is adapter/extension-owned. If clients require native resource browsing or require removed dynamic MCP tools to disappear from `getAllTools()` rather than only from the active tool set, pi needs either a resource UX primitive or an extension `unregisterTool()`/registry-delete primitive.                                                                   |
| Full schema validation                             | Runtime schema smoke tests and fake client validation now cover key adapter responses, every stable `session/update` variant, permission requests, and bridge plan updates; full JSON-RPC envelope coverage and remaining non-update protocol surfaces still need expansion.                                                                                                             |

## Changes likely confined to `pi-acp`

These should not require pi base changes if current pi RPC behavior is sufficient:

`session/close`, no-replay `session/resume`, stable `session/list` wiring, opaque list cursors, list input validation, and extension UI permission bridging are already adapter-owned.

1. Keep schema-driven conformance tests current and expand runtime protocol fixtures beyond the current response/update/permission smoke paths.
2. Finish config compatibility cleanup: keep `configOptions` as preferred state, keep adapter-owned model state under `_meta`, then retire legacy `modes` once clients tolerate config-options-only selection.
3. Add schema fixtures for `session/set_config_option` invalid values, complete-state responses, and mode/config synchronization.
4. Forward pi CLI args or config from `pi-acp` where needed, matching PR #21.
5. Keep the strict UTF-8 JSONL reader covered with malformed/chunked transport fixtures; PR #41 is now locally superseded for the pi RPC bridge shape.
6. Continue failure-surfacing work for tool failures and pre-turn validation; prompt failures now send visible `agent_message_chunk` updates before the schema-compatible `end_turn` fallback.
7. Add stable tests for content conversion, cancellation, permissions, list/load/resume/close, config options, and transport framing.

## Extension-first gaps that may require pi base only as a fallback

These are areas where current code does not appear to have enough support. The first attempt should be an extension-owned service or adapter boundary. A pi base change is justified only after proving the required primitive cannot be provided through existing extension/RPC hooks.

1. MCP servers from ACP session setup: the bundled ACP bridge extension now receives per-session setup, exposes it through `pi.events`, launches/connects stdio MCP servers, registers listed tools with pi, exposes MCP resource list/read methods and resource tool shims, handles dynamic tool additions/resource refreshes, and replaces removed tools with disabled stubs. Expand that service to cover true registry removal if removed tools must disappear completely, native resource UX if tool shims are not acceptable, and ACP-visible error reporting. Move to base only if the model/tool runtime cannot consume extension-provided MCP tools/resources or if stale disabled tools are unacceptable and no extension unregister hook exists.
2. Client-owned filesystem: an extension-provided filesystem service, explicit `acp_read_text_file`/`acp_write_text_file` shims, and shadowed `read`/`write`/`edit` tools now delegate to ACP client fs over bridge RPC when advertised. Deterministic prompt-turn tests exercise the real adapter bridge handler, including multi-edit diff emission; next harden real-provider tool-selection behavior. Base changes are only justified if extension shadowing proves insufficient for model tool selection, permission policy, or file mutation semantics.
3. Client-owned terminals: an extension-provided terminal service now delegates create/output/wait/kill/release to the ACP client, exposes an `acp_terminal_execute` shim, and shadows `bash` in terminal-capable sessions. Pi-acp embeds terminal ids before release, and deterministic prompt-turn tests exercise the real adapter bridge handler. Next, add cancellation/timeout release tests. Base changes are only justified if remaining prompt-turn behavior cannot be verified or controlled through extensions.
4. Session lifecycle semantics: `pi-acp` can kill subprocesses, but robust close/resume/multiple active sessions should first be modeled as adapter session ownership plus extension lifecycle hooks. Base changes are only justified if pi cannot expose enough session identity/state through RPC.
5. Session tree/navigation: pi has closed issue #5119 indicating future RPC surface work for session tree navigation. Refusal history rollback is currently covered through a bundled extension command that uses command-context `navigateTree()`. Base work is only needed if future ACP features require tree navigation from non-command extension services or direct RPC clients rather than this command bridge.
6. Structured mutation details: pi issue #5121 was closed with guidance to read old/new text from tool calls. First normalize this in an extension/shared adapter utility; request base event changes only if old/new text is genuinely unavailable.
7. Model/auth/logout semantics: first expose model/auth/config through adapter-owned config options and extension auth hooks. Base changes are only justified for credential operations that extensions cannot perform.
8. Plan updates: if pi has an internal plan concept, first map it through extension events or a shared extension service. Base changes are only justified if no extension-visible plan signal exists.

## Existing issues and PRs

### `earendil-works/pi`

- [#175 ACP Support](https://github.com/earendil-works/pi/issues/175), closed. Maintainer accepted the idea of non-invasive ACP support but preferred a separate adapter package over a dedicated pi mode.
- [PR #836 feat(coding-agent): add ACP mode for editor integration](https://github.com/earendil-works/pi/pull/836), closed. Useful prior direct-in-pi implementation, but maintainers did not want dedicated ACP mode in pi at that time.
- [PR #241 coding-agent: ACP mode for editor integrations](https://github.com/earendil-works/pi/pull/241), closed. Earlier direct ACP mode attempt.
- [PR #2095 allow supplying custom session ID in newSession()](https://github.com/earendil-works/pi/pull/2095), closed. Relevant to session identity/lifecycle.
- [#5119 Expose session tree and tree navigation in RPC](https://github.com/earendil-works/pi/issues/5119), closed. Indicates future RPC surface refactor for tree navigation.
- [#5121 Expose structured edit/write mutation details over RPC](https://github.com/earendil-works/pi/issues/5121), closed. Maintainer said corresponding tool call contains old/new texts.
- [#2023 Add pi.runWhenIdle()](https://github.com/earendil-works/pi/issues/2023), open. Relevant to extension timing and idle scheduling.

### `svkozak/pi-acp`

Open issues directly relevant to this audit:

- [#43 errors not shown in Zed](https://github.com/svkozak/pi-acp/issues/43)
- [#40 `/resume` slash command](https://github.com/svkozak/pi-acp/issues/40)
- [#38 support command line args](https://github.com/svkozak/pi-acp/issues/38)
- [#36 project-specific packages not loaded](https://github.com/svkozak/pi-acp/issues/36)
- [#35 Node 18 crypto global](https://github.com/svkozak/pi-acp/issues/35)
- [#34 edit/write/bash tool fixes](https://github.com/svkozak/pi-acp/issues/34)
- [#33 IntelliJ connection hangs](https://github.com/svkozak/pi-acp/issues/33)
- [#32 custom session-map location](https://github.com/svkozak/pi-acp/issues/32)
- [#28 session lost after restart](https://github.com/svkozak/pi-acp/issues/28)
- [#26 Ask user not working correctly](https://github.com/svkozak/pi-acp/issues/26)
- [#24 session_info_update not implemented](https://github.com/svkozak/pi-acp/issues/24)
- [#22 Bridge tool-gate extension dialogs to ACP permissions](https://github.com/svkozak/pi-acp/issues/22)
- [#18 Authentication issues](https://github.com/svkozak/pi-acp/issues/18)
- [#17 authentication trouble in Zed](https://github.com/svkozak/pi-acp/issues/17)
- [#15 custom dynamic providers block auth check](https://github.com/svkozak/pi-acp/issues/15)
- [#7 map prompts during streaming to pi steer command](https://github.com/svkozak/pi-acp/issues/7)

Open PRs to review before implementing:

- [PR #45 Bridge extension UI requests through ACP permissions](https://github.com/svkozak/pi-acp/pull/45)
- [PR #42 dedupe startup info emission](https://github.com/svkozak/pi-acp/pull/42)
- [PR #41 replace readline with manual newline JSONL reader](https://github.com/svkozak/pi-acp/pull/41), locally superseded for the pi RPC bridge by `src/pi-rpc/jsonl.ts`.
- [PR #39 auto-restore session after restart](https://github.com/svkozak/pi-acp/pull/39)
- [PR #37 project-level packages in startup info](https://github.com/svkozak/pi-acp/pull/37)
- [PR #31 render bash tools as terminals](https://github.com/svkozak/pi-acp/pull/31)
- [PR #29 support updated pi edit results](https://github.com/svkozak/pi-acp/pull/29)
- [PR #25 automatic ACP session titles](https://github.com/svkozak/pi-acp/pull/25)
- [PR #21 forward non-pi-acp CLI args to pi](https://github.com/svkozak/pi-acp/pull/21)
- [PR #20 support extension commands in ACP](https://github.com/svkozak/pi-acp/pull/20)
- [PR #19 improve Zed integration](https://github.com/svkozak/pi-acp/pull/19)
- [PR #10 Vertex env vars](https://github.com/svkozak/pi-acp/pull/10)

Recently closed/merged items that changed baseline:

- [PR #44 Forward pi session title changes to ACP](https://github.com/svkozak/pi-acp/pull/44), closed
- [PR #12 Enable embeddedContext](https://github.com/svkozak/pi-acp/pull/12), merged
- [PR #3 Windows compatibility](https://github.com/svkozak/pi-acp/pull/3), merged
- Issues #2, #4, #5, #6, #8, #9, #11, #14, #16, #46 are closed and should be regression-tested.

### ACP protocol repository

Relevant protocol movement:

- [#574 session/list tracking](https://github.com/agentclientprotocol/agent-client-protocol/issues/574), closed; [PR #705](https://github.com/agentclientprotocol/agent-client-protocol/pull/705) stabilized `session/list` and `session_info_update`.
- [#1065 session/close tracking](https://github.com/agentclientprotocol/agent-client-protocol/issues/1065), closed; [PR #1062](https://github.com/agentclientprotocol/agent-client-protocol/pull/1062) stabilized `session/close`.
- [#984 session/resume tracking](https://github.com/agentclientprotocol/agent-client-protocol/issues/984), closed; [PR #1051](https://github.com/agentclientprotocol/agent-client-protocol/pull/1051) stabilized `session/resume`.
- [#589 Auth Methods tracking](https://github.com/agentclientprotocol/agent-client-protocol/issues/589), open.
- [PR #1273 stabilize logout](https://github.com/agentclientprotocol/agent-client-protocol/pull/1273), merged.
- [#554 turn-complete signal](https://github.com/agentclientprotocol/agent-client-protocol/issues/554), open.
- [#1104 session/resume real-world feedback](https://github.com/agentclientprotocol/agent-client-protocol/issues/1104), open.
- [PR #1261 mid-turn input via session/inject](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261), open. Relevant to pi steer/follow-up, but not stable v1.
- [PR #582 dynamic MCP server updates](https://github.com/agentclientprotocol/agent-client-protocol/pull/582), open.
- [PR #808 client-owned fs/apply_patch](https://github.com/agentclientprotocol/agent-client-protocol/pull/808), open.
- [PR #1302 requested tool categories](https://github.com/agentclientprotocol/agent-client-protocol/pull/1302), open.

## Test framework design

We should build the tests before implementing missing protocol features. The target is a conformance matrix where every stable method, update variant, content type, capability gate, and transport rule has at least one automated test.

### Test layers

1. Schema and transport tests
   - Import official ACP schema from `agent-client-protocol/schema/schema.json` or the generated SDK schema.
   - Validate every outbound message from `pi-acp` against the stable schema.
   - Validate requests sent by tests before they reach the adapter.
   - Assert stdout contains only newline-delimited JSON-RPC and no non-ACP data.
   - Assert no embedded newline framing violations at the JSONL message boundary.

2. Adapter unit tests with fake pi RPC
   - Continue using `test/helpers/fakes.ts` style tests.
   - Simulate pi events for text, thought, tool starts/deltas/ends, edit/write/bash errors, extension UI, cancellation, auth failures, and process exits.
   - These should be fast and model-free.

3. Protocol component tests with an in-process ACP client
   - Use official TypeScript SDK to drive `PiAcpAgent` directly.
   - Cover method semantics without spawning a real pi binary.
   - Assert exact `session/update` order where ACP requires it, especially `session/load` replay before response and prompt updates before `stopReason`.

4. End-to-end subprocess tests
   - Spawn `pi-acp` as a real process and communicate over stdio.
   - Use temp `PI_CODING_AGENT_DIR` or equivalent to isolate session data.
   - Use a fake or deterministic pi command where possible.
   - Keep real model tests opt-in via env. The previously verified `openai-codex/gpt-5.3-codex-spark` path can be used for smoke tests when credentials are available, but not for mandatory CI.

5. Client capability simulation
   - Provide fake client handlers for `fs/*`, `terminal/*`, and `session/request_permission`.
   - Test both supported and unsupported capability combinations.
   - Assert agent never calls unsupported client methods.

6. Compatibility fixtures
   - Reuse the Python SDK `tests/golden/*.json` as a fixture corpus for content, permission, fs, config, prompt, and session update shapes.
   - Use TypeScript SDK `src/acp.test.ts` and `src/stream.test.ts` as reference patterns for connection behavior.
   - Use Rust SDK `agent-client-protocol-test` and conductor tests as patterns for fake agents and MCP integration.
   - Gascity's `TestACPConformance` is not directly reusable because it targets that runtime provider and an older/different wire shape, but its fake-binary plus reusable provider-test structure is a useful model.

### Required conformance checklist

Baseline connection:

- `initialize` requested version supported
- `initialize` requested version unsupported falls back to latest supported
- omitted capabilities are treated as unsupported
- `agentInfo` and `clientInfo` accepted
- auth methods advertised consistently
- stdout is protocol-only
- stderr logging does not affect protocol

Session lifecycle:

- `session/new` rejects relative `cwd`
- `session/new` returns unique `sessionId`
- `session/new` respects session `cwd`
- `session/new` handles empty `mcpServers`
- `session/new` with stdio `mcpServers` connects or fails visibly once support exists
- `session/load` requires known session and absolute `cwd`
- `session/load` replays all history before response
- `session/resume` does not replay history
- `session/close` cancels active turn, clears queued work, disposes resources, and makes session inactive
- `session/list` supports empty result, cwd filter, pagination, end-of-pages, invalid cursor error
- `session_info_update` partial updates do not include `sessionId` or `cwd`

Prompt turn:

- text prompt streams `agent_message_chunk`
- resource link prompt is accepted
- image prompt accepted only if advertised
- audio prompt rejected or not advertised; no silent data loss
- embedded resource prompt accepted only if advertised
- tool call lifecycle is monotonic and schema-valid
- prompt returns each stable stop reason where pi or an extension-owned bridge can produce it: `end_turn`, `cancelled`, `max_tokens`, `max_turn_requests`, and `refusal`
- refusal prompts restore the pi session leaf to the refused user message's parent before the ACP `session/prompt` response resolves
- prompt failures surface visible error text before the schema-compatible stop reason
- cancellation while permission request is pending returns permission outcome `cancelled` and prompt stop reason `cancelled`
- concurrent prompt behavior is defined and tested

Tools:

- tool call ids are stable and unique in session
- `read`, `edit`, `search`, `execute`/bash, and failure cases map to useful kinds/statuses
- locations are absolute
- edit diffs include absolute path, old text, and new text
- failed tools include `status: failed` and visible output
- terminal content is emitted only when backed by ACP terminal methods

Client methods:

- `session/request_permission` bridge for extension UI confirm/select and configured tool-call preflight
- unsupported permission or UI modes fail visibly
- `fs/read_text_file` only called when advertised
- `fs/write_text_file` only called when advertised and creates files in fake client
- `terminal/create/output/wait_for_exit/kill/release` only called when advertised
- terminal release invalidates terminal id in fake client

Configuration:

- `configOptions` include model selector
- `configOptions` include thought level selector
- every config option has a valid default/current value
- `session/set_config_option` validates unknown ids and values
- response always returns complete config state
- `config_option_update` always returns complete config state
- legacy `modes` and config mode/thought state stay in sync while both exist

Auth:

- auth-required errors use code `-32000`
- `authenticate` validates known method ids, accepts the advertised terminal method, and only succeeds after a pi model-availability probe passes
- successful auth unblocks session creation in a deterministic fake
- advertised `logout` validates against the SDK schema, clears stored `auth.json` credentials, and is omitted when known non-clearable environment or `models.json` auth sources are configured
- provider-auth logout conformance has deterministic unit coverage for capability gating and stored-auth clearing; add a real-pi smoke proving future gated calls require auth in a clean no-env/no-models config after stored credentials are cleared

MCP:

- stdio server config launches and tool/resource availability is exposed to pi
- bad stdio server path returns a visible error
- HTTP/SSE configs are rejected or ignored unless advertised
- all supplied MCP servers are connected or errors are reported
- real pi subprocess E2E verifies stdio MCP tool registration through `pi.getAllTools()`

Extensibility:

- custom data goes under `_meta`
- custom methods start with `_`; `session/set_model` is the only SDK-only compatibility method intentionally served, and it is tracked as a non-stable alias rather than part of the stable v1 inventory
- unknown custom notifications are ignored
- unknown custom requests return method-not-found

### CI shape

Add a machine-readable checklist next to tests, for example `test/conformance/acp-v1-checklist.json`, generated or manually derived from `schema/meta.json` plus this document. Each checklist row should map to one or more test names. CI should fail if a stable method or update variant has no test owner.

Suggested commands once implemented:

```sh
npm run test
npm run typecheck
npm run build
npm run conformance
npm run test:pi-e2e
PI_ACP_REAL_MODEL=1 PI_ACP_MODEL=openai-codex/gpt-5.3-codex-spark npm run smoke
```

## Plan of attack

1. Keep the conformance harness and stable ACP v1 inventory current as the official SDK/docs evolve.
2. Keep closing adapter hardening items that do not require pi changes: compatibility cleanup, broader schema fixtures, real-client smoke tests, and lifecycle edge cases.
3. Review and either merge, rework, or supersede the open `pi-acp` PRs listed above, starting with session restore, title/session metadata, CLI args, and terminal rendering.
4. Expand extension-owned service boundaries for permissions, auth/config, and plan/session metadata. MCP, client filesystem, and client terminal now have reusable bridge-extension service surfaces; each next boundary should stay consumable by other pi extensions.
5. Decide whether client-owned fs/terminal integration is required for full target support or whether pi-local tools plus ACP rendering are acceptable for the near-term client set.
6. Add pi RPC/base APIs only for primitives that cannot be supplied by `pi-acp` or pi extensions.
7. Keep conformance, typecheck, lint, and full test suite required in CI; add opt-in real-provider smoke coverage separately.

## Bottom line

`pi-acp` is a reasonable foundation and now has a green stable ACP v1 checklist with optional unsupported surfaces explicitly capability-gated. The right next move is to keep hardening real-client and real-provider behavior while expanding the bundled bridge extension into services for persistent permissions, auth/config, and richer lifecycle/event surfaces. Pi base changes should happen only after an extension-first attempt proves a primitive is missing.
