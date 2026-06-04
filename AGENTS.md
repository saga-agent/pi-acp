# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com)) adapter for `pi`
(`@earendil-works/pi-coding-agent`).

The adapter speaks ACP JSON-RPC 2.0 over stdio using `@agentclientprotocol/sdk`
and spawns `pi --mode rpc` subprocesses that communicate over newline-delimited
JSON.

## Architecture

### Session model

Pi RPC mode is effectively single-session, so each ACP session owns a dedicated
pi subprocess:

- `session/new` spawns a dedicated `pi --mode rpc` process.
- `session/prompt` sends a pi prompt request and streams pi events back as ACP
  `session/update` notifications.
- `session/cancel` sends pi abort and settles the active turn as cancelled.
- `session/close` cancels active work and disposes session resources.
- `session/load` reattaches to a persisted pi session and replays history.
- `session/resume` reattaches without replaying history.

Multiple ACP sessions may be active at once. Do not add behavior that
proactively closes peer sessions during `session/new`, `session/load`, or
`session/resume`.

### ACP server wiring

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` for ACP stdio transport.
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`.

Keep stdout protocol-only. Pi subprocess stdout/stderr must not leak into ACP
stdout except through adapter-generated JSON-RPC messages.

### Extension-first bridge

Prefer adapter and bundled pi-extension changes over pi base changes. The
extension-first design is the current architecture for ACP surfaces that need
pi-side behavior.

The bundled ACP bridge extension currently provides:

- stdio MCP server setup from ACP `mcpServers`.
- MCP tool registration and tool calls.
- MCP resource list/read service methods and tool shims.
- ACP client filesystem delegation when the client advertises fs capabilities.
- ACP client terminal delegation when the client advertises terminal
  capabilities.
- ACP permission bridging for extension UI and configured sensitive tool calls.
- ACP plan publishing service for independently authored pi extensions.
- Prompt stop-reason override and refusal-history restoration services.

## Implementation constraints / decisions

- Target stable ACP v1 conformance. Use
  `test/conformance/acp-v1-meta.json` and
  `test/conformance/acp-v1-checklist.json` as the frozen stable inventory.
- Treat SDK-only unstable/compatibility surfaces separately. For example,
  `session/set_model` is kept as an explicit compatibility alias for model
  config selection.
- Prefer ACP `configOptions` for model and thought-level selection. Legacy
  `modes` remains transitional for client compatibility.
- Prefer ACP client-side filesystem and terminal delegation when the client
  advertises those capabilities. Keep pi-local file and terminal behavior as
  fallback for clients without those capabilities.
- Wire ACP `mcpServers` through the bundled bridge extension for
  `session/new`, `session/load`, and `session/resume`.
- Stream assistant text as `agent_message_chunk` and thinking deltas as
  `agent_thought_chunk`.
- Map pi tool execution events to ACP `tool_call` / `tool_call_update`, with
  structured content, locations, raw input/output, and diffs when available.
- Keep vendor/client-specific data under `_meta`; do not add custom root-level
  fields to ACP protocol-defined objects.
- All protocol file paths emitted by the adapter must be absolute unless the
  ACP field explicitly allows otherwise.

## Dev Workflow

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Unit/component/conformance tests: `npm run test`
- Conformance-only tests: `npm run conformance`
- Real pi subprocess E2E: `npm run test:pi-e2e`
- Smoke test: `npm run smoke`

`npm run test:pi-e2e` requires `PI_ACP_TEST_PI_COMMAND` or a local pi checkout
and build in the expected neighboring location. If that prerequisite is
missing, the E2E tests skip.

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bash
# Send initialize request via stdin.
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Keep bundled pi extension bridge logic in `src/pi-extension/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).
- Prefer extension-owned service boundaries before proposing pi base changes.

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- For behavior changes, run `npm run typecheck`, `npm run lint`, and the relevant tests. Prefer `npm run test` for adapter changes and `npm run conformance` for ACP wire-shape changes.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!

## Client information

- Current ACP client is Zed

## References

- Local ACP repo with protocol documentation and specs: `~/Dev/learning/agent-client-protocol`
- Local Zed repo `~/Dev/learning/zed/zed`
- Current architecture audit: `docs/acp-implementation-audit.md`
- Extension-first design: `docs/acp-extension-first-design.md`
