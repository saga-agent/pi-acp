import type {
  AgentSideConnection,
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import type { PiAcpBridgeSetup } from '../pi-rpc/bridge-extension.js'
import type { BridgeRpcHandler } from '../pi-rpc/bridge-rpc.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/pi-tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { createClientBridgeRpcHandler, shouldStartClientBridgeRpc } from './client-bridge.js'
import type { PromptStopReasonOverrideStore } from './client-stop-reasons.js'
import { supportsClientTerminal } from './client-terminal.js'
import type { PromptResourceLink, PromptResourceStore } from './prompt-resources.js'
import { ACP_RESTORE_REFUSAL_HISTORY_COMMAND } from './refusal-history.js'
import { toToolKind } from './tool-kind.js'
import {
  getSessionConfigOptions,
  isThinkingLevel,
  type ConfigStateOverride,
  type ThinkingLevel
} from './config-options.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  bridgeSetup?: PiAcpBridgeSetup
  bridgeRpcHandler?: BridgeRpcHandler | null
  promptResourceStore?: PromptResourceStore | null
  stopReasonOverrides?: PromptStopReasonOverrideStore | null
  terminalBackedToolNames?: string[]
  authMethods?: AuthMethod[]
}

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'error'

type PendingTurn = {
  id: number
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  id: number
  message: string
  images: unknown[]
  resourceLinks: PromptResourceLink[]
  commandLike: boolean
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

const COMMAND_PROMPT_IDLE_CHECK_DELAY_MS = 1_000
const EXTENSION_STATUS_SURFACE_METHODS = new Set([
  'status',
  'setStatus',
  'widget',
  'setWidget',
  'title',
  'setTitle',
  'set_editor_text',
  'editor_text'
])

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function isCommandLikePrompt(message: string): boolean {
  return message.trimStart().startsWith('/')
}

function historyCustomMessageKey(message: unknown, index: number): string | null {
  const raw = message as Record<string, unknown> | null | undefined
  if (raw?.role !== 'custom') return null

  const timestamp =
    typeof raw.timestamp === 'string' || typeof raw.timestamp === 'number' ? String(raw.timestamp) : `index:${index}`
  const customType = typeof raw.customType === 'string' ? raw.customType : 'custom'
  const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? null)

  return `${timestamp}:${customType}:${content}`
}

function historyCustomMessageText(message: unknown): string | null {
  const raw = message as Record<string, unknown> | null | undefined
  if (raw?.role !== 'custom') return null
  if (raw.display === false) return null

  if (typeof raw.content === 'string') return raw.content
  if (Array.isArray(raw.content)) {
    const text = raw.content
      .map(block => {
        if (typeof block === 'string') return block
        if (typeof (block as { text?: unknown } | null | undefined)?.text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return text || null
  }

  return null
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
      ? (args as { path: string }).path
      : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

function adapterManagedTerminalId(result: unknown): string | null {
  const details = (result as { details?: unknown } | null | undefined)?.details
  if (!details || typeof details !== 'object') return null

  const raw = details as { source?: unknown; terminalRelease?: unknown; terminalId?: unknown }
  if (raw.source !== 'acp-client-terminal') return null
  if (raw.terminalRelease !== 'pi-acp-after-tool-call-update') return null
  return typeof raw.terminalId === 'string' && raw.terminalId ? raw.terminalId : null
}

function terminalToolCallContent(result: unknown, text: string): ToolCallContent[] | null {
  const terminalId = adapterManagedTerminalId(result)
  if (!terminalId) return null

  return [
    { type: 'terminal', terminalId },
    ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
  ]
}

function adapterManagedDiffContent(result: unknown, text: string): ToolCallContent[] | null {
  const details = (result as { details?: unknown } | null | undefined)?.details
  if (!details || typeof details !== 'object') return null

  const raw = details as { source?: unknown; path?: unknown; oldText?: unknown; newText?: unknown }
  if (raw.source !== 'acp-client-fs') return null
  if (typeof raw.path !== 'string' || !raw.path) return null
  if (!isAbsolute(raw.path)) return null
  if (typeof raw.newText !== 'string') return null
  if (raw.oldText !== null && typeof raw.oldText !== 'string') return null
  if (raw.oldText === raw.newText) return null

  return [
    {
      type: 'diff',
      path: raw.path,
      oldText: raw.oldText,
      newText: raw.newText
    },
    ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
  ]
}

function terminalBackedToolNames(capabilities: unknown): string[] {
  return supportsClientTerminal(capabilities as any) ? ['bash', 'acp_terminal_execute'] : []
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.clearPromptResourceLinks()
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    let bridgeSessionId = typeof params.bridgeSetup?.sessionId === 'string' ? params.bridgeSetup.sessionId : null
    const bridgeRpcHandler =
      params.bridgeSetup && shouldStartClientBridgeRpc(params.bridgeSetup.clientCapabilities as any)
        ? createClientBridgeRpcHandler({
            conn: params.conn,
            clientCapabilities: params.bridgeSetup.clientCapabilities as any,
            getSessionId: () => bridgeSessionId,
            promptResourceStore: params.promptResourceStore,
            stopReasonOverrides: params.stopReasonOverrides
          })
        : null

    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        bridgeSetup: params.bridgeSetup,
        bridgeRpcHandler
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    bridgeSessionId = sessionId
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      bridgeRpcHandler,
      promptResourceStore: params.promptResourceStore,
      stopReasonOverrides: params.stopReasonOverrides,
      terminalBackedToolNames: terminalBackedToolNames(params.bridgeSetup?.clientCapabilities),
      authMethods: params.authMethods
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      bridgeRpcHandler: params.bridgeRpcHandler ?? null,
      promptResourceStore: params.promptResourceStore,
      stopReasonOverrides: params.stopReasonOverrides,
      terminalBackedToolNames:
        params.terminalBackedToolNames ?? terminalBackedToolNames(params.bridgeSetup?.clientCapabilities),
      authMethods: params.authMethods
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSentOutOfTurn = false
  private startupInfoSentInPrompt = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly bridgeRpcHandler: BridgeRpcHandler | null
  private readonly promptResourceStore: PromptResourceStore | null
  private readonly stopReasonOverrides: PromptStopReasonOverrideStore | null
  private readonly terminalBackedToolNames: Set<string>
  private readonly authMethods: AuthMethod[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  private nextTurnId = 1
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string }>()
  private pendingExtensionUiPermissions = new Set<string>()
  private readonly extensionConfirmPolicies = new Map<string, boolean>()
  private refusalHistoryRestoreCommandAvailable: boolean | null = null
  private readonly emittedCustomMessageKeys = new Set<string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    bridgeRpcHandler?: BridgeRpcHandler | null
    promptResourceStore?: PromptResourceStore | null
    stopReasonOverrides?: PromptStopReasonOverrideStore | null
    terminalBackedToolNames?: string[]
    authMethods?: AuthMethod[]
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.bridgeRpcHandler = opts.bridgeRpcHandler ?? null
    this.promptResourceStore = opts.promptResourceStore ?? null
    this.stopReasonOverrides = opts.stopReasonOverrides ?? null
    this.terminalBackedToolNames = new Set(opts.terminalBackedToolNames ?? [])
    this.authMethods = opts.authMethods ?? []

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSentOutOfTurn = false
    this.startupInfoSentInPrompt = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSentOutOfTurn || !this.startupInfo) return
    this.startupInfoSentOutOfTurn = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    if (this.startupInfoSentInPrompt || !this.startupInfo) return
    this.startupInfoSentInPrompt = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  clearPromptResourceLinks(): void {
    this.promptResourceStore?.clearSessionResourceLinks(this.sessionId)
  }

  private emitConfigOptionUpdate(pre?: ConfigStateOverride): void {
    void getSessionConfigOptions(this.proc, pre)
      .then(configOptions => {
        this.emit({
          sessionUpdate: 'config_option_update',
          configOptions
        })
      })
      .catch(() => {
        // Best-effort; config updates should not interrupt prompt/tool event handling.
      })
  }

  async prompt(message: string, images: unknown[] = [], resourceLinks: PromptResourceLink[] = []): Promise<StopReason> {
    // Keep a prompt-path fallback because some clients may ignore the best-effort
    // pre-prompt notification sent right after session/new.
    this.sendStartupInfoOnFirstPromptIfPending()

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = {
        id: this.nextTurnId++,
        message: expandedMessage,
        images,
        resourceLinks,
        commandLike: isCommandLikePrompt(expandedMessage),
        resolve,
        reject
      }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    for (const id of this.pendingExtensionUiPermissions) {
      this.proc.sendExtensionUiResponse({ id, cancelled: true })
    }
    this.pendingExtensionUiPermissions.clear()

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private releaseAdapterManagedTerminalAfterEmit(terminalId: string): void {
    if (!this.bridgeRpcHandler) return

    void this.flushEmits()
      .then(() => this.bridgeRpcHandler?.('terminal/release', { terminalId }))
      .catch(() => {
        // Terminal release is cleanup. A failed release should not break prompt completion.
      })
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.stopReasonOverrides?.clear(this.sessionId)
    this.promptResourceStore?.setSessionResourceLinks(this.sessionId, t.resourceLinks)

    this.pendingTurn = { id: t.id, resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    // The full prompt is finished when we see `agent_end`.
    this.proc
      .prompt(t.message, t.images)
      .then(() => {
        if (t.commandLike) this.scheduleCommandPromptIdleResolution(t.id)
      })
      .catch(err => {
        // If the subprocess errors before we get an `agent_end`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        const authErr = maybeAuthRequiredError(err, { authMethods: this.authMethods })
        if (!authErr && !this.cancelRequested) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: formatPromptError(err) } satisfies ContentBlock
          })
        }

        void this.flushEmits().finally(() => {
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else {
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
            this.pendingTurn?.resolve(reason)
          }

          this.finishPromptTurn({ startNextQueued: false })
        })
        void err
      })
  }

  private scheduleCommandPromptIdleResolution(turnId: number): void {
    const timer = setTimeout(() => {
      void this.resolveCommandPromptIfIdle(turnId)
    }, COMMAND_PROMPT_IDLE_CHECK_DELAY_MS)
    timer.unref?.()
  }

  private async resolveCommandPromptIfIdle(turnId: number): Promise<void> {
    if (this.pendingTurn?.id !== turnId || this.inAgentLoop) return

    let state: any = null
    try {
      state = (await this.proc.getState()) as any
    } catch {
      return
    }

    if (this.pendingTurn?.id !== turnId || this.inAgentLoop) return
    if (state?.isStreaming || state?.isCompacting) return

    await this.emitNewCustomMessagesFromHistory()
    await this.flushEmits()

    if (this.pendingTurn?.id !== turnId || this.inAgentLoop) return
    this.pendingTurn.resolve('end_turn')
    this.finishPromptTurn({ startNextQueued: true })
  }

  private async emitNewCustomMessagesFromHistory(): Promise<void> {
    let messages: unknown[]
    try {
      const data = (await this.proc.getMessages()) as { messages?: unknown[] }
      messages = Array.isArray(data?.messages) ? data.messages : []
    } catch {
      return
    }

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const key = historyCustomMessageKey(message, index)
      if (!key || this.emittedCustomMessageKeys.has(key)) continue
      this.emittedCustomMessageKeys.add(key)

      const text = historyCustomMessageText(message)
      if (!text) continue

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text } satisfies ContentBlock
      })
    }
  }

  private finishPromptTurn(opts: { startNextQueued: boolean }): void {
    this.pendingTurn = null
    this.inAgentLoop = false
    this.clearPromptResourceLinks()

    if (opts.startNextQueued) {
      const next = this.turnQueue.shift()
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next)
        return
      }
    }

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName, this.terminalBackedToolNames),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? args.oldText : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // Ignore snapshot failures; we'll fall back to plain text output.
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName, this.terminalBackedToolNames),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        const text = toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)
        const adapterTerminalId = adapterManagedTerminalId(result)

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined =
          terminalToolCallContent(result, text) ??
          (!isError ? adapterManagedDiffContent(result, text) : null) ??
          undefined

        if (!content && !isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: abs,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content.
        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: result
        })

        if (adapterTerminalId) this.releaseAdapterManagedTerminalAfterEmit(adapterTerminalId)

        this.currentToolCalls.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
        break
      }

      case 'model_update': {
        const currentModelId = modelUpdateCurrentModelId(ev)
        this.emitConfigOptionUpdate(currentModelId ? { currentModelId } : undefined)
        break
      }

      case 'thinking_level_update': {
        const level = String((ev as any).level ?? '')
        if (!isThinkingLevel(level)) break

        this.emit({
          sessionUpdate: 'current_mode_update',
          currentModeId: level
        })
        this.emitConfigOptionUpdate({ currentThinkingLevel: level as ThinkingLevel })
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev)
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        const errorMessage = this.cancelRequested || Boolean((ev as any).willRetry) ? null : agentEndErrorMessage(ev)
        if (errorMessage) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: formatPromptError(errorMessage) } satisfies ContentBlock
          })
        }

        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void this.flushEmits().finally(async () => {
          const override = this.stopReasonOverrides?.take(this.sessionId)?.stopReason
          let reason: StopReason = this.cancelRequested
            ? 'cancelled'
            : (override ?? (errorMessage ? 'error' : agentEndStopReason(ev)))

          if (reason === 'refusal' && !(await this.restoreRefusalHistory())) {
            reason = 'end_turn'
          }

          this.pendingTurn?.resolve(reason)
          this.finishPromptTurn({ startNextQueued: true })
        })
        break
      }

      default:
        break
    }
  }

  private async restoreRefusalHistory(): Promise<boolean> {
    try {
      if (this.refusalHistoryRestoreCommandAvailable === null) {
        this.refusalHistoryRestoreCommandAvailable = await this.hasRefusalHistoryRestoreCommand()
      }
      if (!this.refusalHistoryRestoreCommandAvailable) return false

      this.stopReasonOverrides?.takeRefusalHistoryRestore(this.sessionId)
      await this.proc.prompt(`/${ACP_RESTORE_REFUSAL_HISTORY_COMMAND}`)
      const result = this.stopReasonOverrides?.takeRefusalHistoryRestore(this.sessionId)
      if (result?.restored === false) {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: {
            piAcp: {
              refusalHistoryRestored: false,
              refusalHistoryRestoreReason: result.reason ?? 'unknown'
            }
          }
        })
        return false
      }
      return result?.restored === true
    } catch {
      // ACP refusal carries history semantics. If rollback cannot be proven,
      // downgrade the final stop reason instead of returning a misleading refusal.
      return false
    }
  }

  private async hasRefusalHistoryRestoreCommand(): Promise<boolean> {
    const response = (await this.proc.getCommands()) as { commands?: Array<{ name?: unknown }> }
    const commands = Array.isArray(response?.commands) ? response.commands : []
    return commands.some(command => command?.name === ACP_RESTORE_REFUSAL_HISTORY_COMMAND)
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = typeof (ev as any).id === 'string' ? (ev as any).id : ''
    const method = String((ev as any).method ?? '')
    if (!id) return

    if (method === 'notify') {
      const text = extensionNotifyText(ev)
      if (text) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text } satisfies ContentBlock
        })
      }
      return
    }

    if (EXTENSION_STATUS_SURFACE_METHODS.has(method)) {
      this.emitExtensionStatusSurface(ev)
      this.proc.sendExtensionUiResponse({ id, ok: true })
      return
    }

    if (method !== 'select' && method !== 'confirm') {
      this.emitUnsupportedExtensionUiMethod(method)
      this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'confirm') {
      const policy = this.extensionConfirmPolicies.get(confirmPolicyKey(ev))
      if (typeof policy === 'boolean') {
        this.proc.sendExtensionUiResponse({ id, confirmed: policy })
        return
      }
    }

    this.pendingExtensionUiPermissions.add(id)

    try {
      const request = toPermissionRequest(this.sessionId, ev)
      const response = await this.conn.requestPermission(request)
      if (!this.pendingExtensionUiPermissions.delete(id)) return

      const outcome = response.outcome
      if (outcome.outcome === 'cancelled') {
        this.proc.sendExtensionUiResponse({ id, cancelled: true })
        return
      }

      if (method === 'confirm') {
        const confirmed = outcome.optionId === 'confirm' || outcome.optionId === 'confirm_always'
        if (outcome.optionId === 'confirm_always' || outcome.optionId === 'reject_always') {
          this.extensionConfirmPolicies.set(confirmPolicyKey(ev), confirmed)
        }
        this.proc.sendExtensionUiResponse({ id, confirmed })
        return
      }

      const selected = request.options.find(option => option.optionId === outcome.optionId)
      const value = selected?._meta?.piAcpExtensionUiValue
      if (typeof value === 'string') {
        this.proc.sendExtensionUiResponse({ id, value })
        return
      }

      this.proc.sendExtensionUiResponse({ id, cancelled: true })
    } catch {
      this.pendingExtensionUiPermissions.delete(id)
      this.proc.sendExtensionUiResponse({ id, cancelled: true })
    }
  }

  private emitExtensionStatusSurface(ev: PiRpcEvent): void {
    const surface = extensionStatusSurface(ev)
    if (surface.title) {
      this.emit({
        sessionUpdate: 'session_info_update',
        title: surface.title
      } as SessionUpdate)
    }

    if (surface.text) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: surface.text ?? '' } satisfies ContentBlock,
        _meta: {
          piAcp: {
            extensionStatusSurface: surface.meta
          }
        }
      })
    }
  }

  private emitUnsupportedExtensionUiMethod(method: string): void {
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `Unsupported Pi extension UI method \`${boundedExtensionUiValue(method)}\` was cancelled.`
      } satisfies ContentBlock,
      _meta: {
        piAcp: {
          unsupportedExtensionUiMethod: boundedExtensionUiValue(method)
        }
      }
    })
  }
}

function toPermissionRequest(sessionId: string, ev: PiRpcEvent): RequestPermissionRequest {
  const id = String((ev as any).id)
  const method = String((ev as any).method ?? '')
  const title =
    typeof (ev as any).title === 'string' && (ev as any).title.trim() ? String((ev as any).title) : 'Extension UI'
  const rawInput =
    method === 'confirm'
      ? { method, title, message: String((ev as any).message ?? '') }
      : { method, title, options: Array.isArray((ev as any).options) ? (ev as any).options : [] }

  return {
    sessionId,
    toolCall: {
      toolCallId: `extension-ui:${id}`,
      title,
      kind: 'other' as const,
      status: 'pending' as const,
      rawInput,
      _meta: {
        piAcp: {
          extensionUiRequestId: id,
          extensionUiMethod: method
        }
      }
    },
    options: toPermissionOptions(ev)
  }
}

function toPermissionOptions(ev: PiRpcEvent): PermissionOption[] {
  const method = String((ev as any).method ?? '')

  if (method === 'confirm') {
    return [
      { optionId: 'confirm', name: 'Confirm', kind: 'allow_once' },
      { optionId: 'confirm_always', name: 'Always confirm', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }
    ]
  }

  const rawOptions: unknown[] = Array.isArray((ev as any).options) ? (ev as any).options : []
  const options = rawOptions.map((option: unknown, index: number) => {
    const value = String(option)
    return {
      optionId: `option-${index}`,
      name: value,
      kind: 'allow_once',
      _meta: {
        piAcpExtensionUiValue: value
      }
    } satisfies PermissionOption
  })

  return [...options, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }]
}

function confirmPolicyKey(ev: PiRpcEvent): string {
  const title =
    typeof (ev as any).title === 'string' && (ev as any).title.trim() ? String((ev as any).title) : 'Extension UI'
  const message = String((ev as any).message ?? '')
  return JSON.stringify({ method: 'confirm', title, message })
}

function extensionNotifyText(ev: PiRpcEvent): string | null {
  const message = typeof (ev as any).message === 'string' ? (ev as any).message.trim() : ''
  if (!message) return null

  const notifyType = typeof (ev as any).notifyType === 'string' ? (ev as any).notifyType : 'info'
  if (notifyType === 'error') return `Extension error: ${message}`
  if (notifyType === 'warning') return `Extension warning: ${message}`
  return `Extension notice: ${message}`
}

function extensionStatusSurface(ev: PiRpcEvent): {
  title?: string
  text?: string
  meta?: Record<string, unknown>
} {
  const method = String((ev as any).method ?? '')
  const key = firstExtensionUiString(ev, ['statusKey', 'status_key', 'widgetKey', 'widget_key', 'key'])
  const title = firstExtensionUiString(ev, ['title', 'statusTitle', 'status_title'])
  const severity = firstExtensionUiString(ev, ['severity', 'notifyType', 'notify_type'])
  const progress =
    typeof (ev as any).progress === 'number' && Number.isFinite((ev as any).progress)
      ? Math.max(0, Math.min(1, (ev as any).progress))
      : undefined
  const clear = Boolean((ev as any).clear)
  const lines = Array.isArray((ev as any).widgetLines)
    ? (ev as any).widgetLines
    : Array.isArray((ev as any).widget_lines)
      ? (ev as any).widget_lines
      : undefined
  const lineText = Array.isArray(lines)
    ? lines
        .map(line => String(line))
        .filter(Boolean)
        .join('\n')
    : ''
  const body = firstExtensionUiString(ev, [
    'statusText',
    'status_text',
    'text',
    'message',
    'value',
    'editorText',
    'editor_text'
  ])
  const displayText = lineText || body
  const label = key ? `${method} ${key}` : method
  const text = clear
    ? `Extension UI cleared ${label}.`
    : displayText
      ? `Extension UI ${label}: ${displayText}`
      : title && (method === 'title' || method === 'setTitle')
        ? undefined
        : `Extension UI ${label}.`

  return {
    title,
    text,
    meta: {
      method,
      ...(key ? { key } : {}),
      ...(severity ? { severity } : {}),
      ...(progress === undefined ? {} : { progress }),
      ...(clear ? { clear: true } : {})
    }
  }
}

function firstExtensionUiString(ev: PiRpcEvent, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = (ev as any)[key]
    if (typeof value === 'string' && value.trim()) return boundedExtensionUiValue(value)
  }
  return undefined
}

function boundedExtensionUiValue(value: string): string {
  return value.length <= 4000 ? value : `${value.slice(0, 4000)}...`
}

function formatPromptError(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  return `Prompt failed: ${message || 'Unknown error'}`
}

function agentEndErrorMessage(ev: PiRpcEvent): string | null {
  const messages = Array.isArray((ev as any).messages) ? (ev as any).messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (message?.stopReason !== 'error') return null
    return typeof message?.errorMessage === 'string' && message.errorMessage.trim()
      ? message.errorMessage
      : 'Assistant returned an error stop reason'
  }
  return null
}

function agentEndStopReason(ev: PiRpcEvent): StopReason {
  const messages = Array.isArray((ev as any).messages) ? (ev as any).messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (message?.stopReason === 'length' || message?.stopReason === 'max_tokens') return 'max_tokens'
    if (message?.stopReason === 'max_turn_requests') return 'max_turn_requests'
    if (message?.stopReason === 'refusal') return 'refusal'
    return 'end_turn'
  }
  return 'end_turn'
}

function modelUpdateCurrentModelId(ev: PiRpcEvent): string | null {
  const model = (ev as { model?: unknown }).model
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null

  const provider = String((model as { provider?: unknown }).provider ?? '').trim()
  const id = String((model as { id?: unknown }).id ?? '').trim()
  if (!provider || !id) return null
  return `${provider}/${id}`
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}
