import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type PromptCapabilities,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager } from './session.js'
import { SessionStore } from './session-store.js'
import { PiRpcProcess, PiRpcSpawnError } from '../pi-rpc/process.js'
import type { PiAcpBridgeSetup } from '../pi-rpc/bridge-extension.js'
import { listPiSessions, findPiSessionFile } from './pi-sessions.js'
import { piAssistantContentToAcpBlocks, piMessageContentToAcpBlocks } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { createClientBridgeRpcHandler, shouldStartClientBridgeRpc } from './client-bridge.js'
import { PromptStopReasonOverrideStore } from './client-stop-reasons.js'
import { clearStoredPiAuth, getPiLogoutSupport, PI_LOGOUT_CLEARS, PI_LOGOUT_DOES_NOT_CLEAR } from './logout.js'
import { PromptResourceStore } from './prompt-resources.js'
import { toToolKind } from './tool-kind.js'
import {
  getModelState,
  getSessionConfigOptions,
  getThinkingState,
  isThinkingLevel,
  MODEL_CONFIG_ID,
  resolveModelSelection,
  THOUGHT_LEVEL_CONFIG_ID,
  toSessionConfigOptions,
  type ConfigStateOverride,
  type ModelState
} from './config-options.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type PiAcpSessionMeta = {
  piAcp: {
    startupInfo: string | null
    models: ModelState
  }
}

type HistoricToolCall = {
  id: string
  name: string
  args: unknown
}

const SESSION_LIST_CURSOR_PREFIX = 'pi-acp-list:'
const DEFAULT_TOOL_PERMISSION_NAMES = [
  'bash',
  'acp_terminal_execute',
  'write',
  'edit',
  'delete',
  'move',
  'acp_write_text_file'
]

function currentPromptCapabilities(): PromptCapabilities {
  return {
    image: true,
    audio: false,
    embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
  }
}

function validatePromptContentCapabilities(blocks: PromptRequest['prompt'], capabilities: PromptCapabilities): void {
  for (const block of blocks) {
    if (block.type === 'image' && capabilities.image !== true) {
      throw RequestError.invalidParams('image prompt content is not supported by this pi-acp session')
    }

    if (block.type === 'audio' && capabilities.audio !== true) {
      throw RequestError.invalidParams('audio prompt content is not supported by this pi-acp session')
    }

    if (block.type === 'resource' && capabilities.embeddedContext !== true) {
      throw RequestError.invalidParams('embedded resource prompt content requires promptCapabilities.embeddedContext')
    }
  }
}

function toPiAcpSessionMeta(startupInfo: string | null, models: ModelState): PiAcpSessionMeta {
  return {
    piAcp: {
      startupInfo,
      models
    }
  }
}

function collectHistoricToolResultIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const raw = message as Record<string, unknown>
    if (raw.role !== 'toolResult') continue
    const id = requiredString(raw.toolCallId)
    if (id) ids.add(id)
  }
  return ids
}

function toHistoricToolCall(value: unknown): HistoricToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.type !== 'toolCall') return null

  const id = requiredString(raw.id)
  const name = requiredString(raw.name)
  if (!id || !name) return null

  return {
    id,
    name,
    args: raw.arguments === undefined ? null : raw.arguments
  }
}

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}

function encodeSessionListCursor(offset: number): string {
  return SESSION_LIST_CURSOR_PREFIX + Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeSessionListCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  if (!cursor.startsWith(SESSION_LIST_CURSOR_PREFIX)) {
    throw RequestError.invalidParams('Invalid session/list cursor')
  }

  try {
    const raw = Buffer.from(cursor.slice(SESSION_LIST_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    const decoded = JSON.parse(raw) as { offset?: unknown }
    const offset = decoded.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('invalid offset')
    return offset
  } catch {
    throw RequestError.invalidParams('Invalid session/list cursor')
  }
}

import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly stopReasonOverrides = new PromptStopReasonOverrideStore()
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly promptResources = new PromptResourceStore()

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null
  private clientCapabilities: ClientCapabilities | null = null
  private promptCapabilities: PromptCapabilities = currentPromptCapabilities()

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private createBridgeSetup(
    lifecycle: PiAcpBridgeSetup['lifecycle'],
    cwd: string,
    mcpServers: unknown[] | null | undefined,
    sessionId: string | null
  ): PiAcpBridgeSetup {
    return {
      version: 1,
      lifecycle,
      cwd,
      sessionId,
      mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
      clientCapabilities: this.clientCapabilities,
      toolCallPermissions: {
        enabled: true,
        toolNames: DEFAULT_TOOL_PERMISSION_NAMES
      },
      createdAt: new Date().toISOString()
    }
  }

  private createBridgeRpcHandler(sessionId: string) {
    if (!shouldStartClientBridgeRpc(this.clientCapabilities)) return null
    return createClientBridgeRpcHandler({
      conn: this.conn,
      clientCapabilities: this.clientCapabilities,
      getSessionId: () => sessionId,
      promptResourceStore: this.promptResources,
      stopReasonOverrides: this.stopReasonOverrides
    })
  }

  private terminalBackedToolNames(): string[] {
    return this.clientCapabilities?.terminal === true ? ['bash', 'acp_terminal_execute'] : []
  }

  private authMethods() {
    return getAuthMethods({
      supportsTerminalAuth: this.clientCapabilities?.auth?.terminal === true,
      supportsTerminalAuthMeta: this.clientCapabilities?._meta?.['terminal-auth'] === true
    })
  }

  private cleanupAuthProbeSessionFile(state: unknown): void {
    const sessionFile =
      typeof (state as { sessionFile?: unknown } | null)?.sessionFile === 'string'
        ? (state as { sessionFile: string }).sessionFile
        : null
    if (!sessionFile) return

    try {
      if (existsSync(sessionFile)) unlinkSync(sessionFile)
    } catch {
      // Advisory cleanup only; auth readiness is the primary result.
    }
  }

  private async assertAuthenticationReady(): Promise<void> {
    let proc: PiRpcProcess | null = null
    let state: unknown = null

    try {
      proc = await PiRpcProcess.spawn({
        cwd: this.lastSessionCwd ?? process.cwd(),
        piCommand: process.env.PI_ACP_PI_COMMAND
      })

      try {
        state = await proc.getState()
      } catch {
        state = null
      }

      const availableModels = (await proc.getAvailableModels()) as any
      const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0
      if (rawModelsCount > 0) return

      throw RequestError.authRequired(
        { authMethods: this.authMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    } catch (err) {
      const authErr = maybeAuthRequiredError(err, { authMethods: this.authMethods() })
      if (authErr) throw authErr
      if (err instanceof RequestError) throw err
      if (err instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: err.code }, err.message)
      }
      throw RequestError.internalError({}, String((err as Error)?.message ?? err))
    } finally {
      try {
        proc?.dispose()
      } catch {
        // ignore
      }
      this.cleanupAuthProbeSessionFile(state)
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? null
    this.promptCapabilities = currentPromptCapabilities()
    const logoutSupport = getPiLogoutSupport()

    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Advertise terminal auth only to SDK-capable clients or legacy Zed clients that opt into
      // ClientCapabilities._meta["terminal-auth"] for the Authenticate banner/button.
      authMethods: this.authMethods(),
      agentCapabilities: {
        auth: {
          _meta: {
            piAcp: {
              logoutSupported: logoutSupport.supported,
              nonClearableSources: logoutSupport.nonClearableSources
            }
          },
          ...(logoutSupport.supported
            ? {
                logout: {
                  _meta: {
                    piAcp: {
                      clears: [...PI_LOGOUT_CLEARS],
                      doesNotClear: [...PI_LOGOUT_DOES_NOT_CLEAR],
                      nonClearableSources: logoutSupport.nonClearableSources
                    }
                  }
                }
              }
            : {})
        },
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: this.promptCapabilities,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Stage ACP session setup into the bundled bridge extension. The bridge does
    // not connect MCP servers yet, but it gives extension-owned code the data.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      promptResourceStore: this.promptResources,
      stopReasonOverrides: this.stopReasonOverrides,
      bridgeSetup: this.createBridgeSetup('new', params.cwd, params.mcpServers, null),
      authMethods: this.authMethods()
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr, { authMethods: this.authMethods() })

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: this.authMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr, { authMethods: this.authMethods() })) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: this.authMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    const models = await getModelState(session.proc, { state, availableModels })
    const thinking = await getThinkingState(session.proc, { state })
    const configOptions = toSessionConfigOptions(models, thinking)

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      modes: thinking,
      _meta: toPiAcpSessionMeta(preludeText || null, models)
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await session.proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async authenticate(params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // When the client calls `authenticate` for the advertised terminal method, verify that
    // pi can now see at least one authenticated model before reporting success.
    const knownMethodIds = this.authMethods().map(method => method.id)
    if (!knownMethodIds.includes(params.methodId)) {
      throw RequestError.invalidParams(
        { methodId: params.methodId, availableMethodIds: knownMethodIds },
        `Unknown authentication method: ${params.methodId}`
      )
    }

    await this.assertAuthenticationReady()
    return {}
  }

  async unstable_logout(_params: LogoutRequest): Promise<LogoutResponse> {
    const support = getPiLogoutSupport()
    if (!support.supported) {
      throw RequestError.invalidParams(
        { nonClearableSources: support.nonClearableSources },
        'logout is not available while non-clearable pi auth sources are configured'
      )
    }

    const result = clearStoredPiAuth()

    return {
      _meta: {
        piAcp: {
          clears: [...PI_LOGOUT_CLEARS],
          doesNotClear: [...PI_LOGOUT_DOES_NOT_CLEAR],
          nonClearableSources: support.nonClearableSources,
          invalidAuthFileCleared: result.invalidAuthFileCleared,
          removedProviders: result.removedProviders
        }
      }
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    validatePromptContentCapabilities(params.prompt, this.promptCapabilities)

    const { message, images, resourceLinks } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = (await session.proc.getSessionStats()) as any

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images, resourceLinks)

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)

    try {
      await session.cancel()
    } catch {
      // Closing should still free adapter resources even if the underlying pi process
      // is already gone or cannot accept an abort command.
    }

    this.sessions.close(params.sessionId)
    return {}
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.unstable_listSessions(params)
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    if (effectiveCwd && !isAbsolute(effectiveCwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${effectiveCwd}`)
    }

    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    const start = decodeSessionListCursor(params.cursor)

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? encodeSessionListCursor(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const existing = this.sessions.maybeGet(params.sessionId)
    if (existing) {
      if (existing.cwd !== params.cwd) {
        throw RequestError.invalidParams(
          `session/resume cwd does not match active session cwd: ${params.cwd} !== ${existing.cwd}`
        )
      }

      this.lastSessionCwd = params.cwd
      const models = await getModelState(existing.proc)
      const thinking = await getThinkingState(existing.proc)
      return {
        configOptions: toSessionConfigOptions(models, thinking),
        modes: thinking,
        _meta: toPiAcpSessionMeta(null, models)
      }
    }

    this.lastSessionCwd = params.cwd

    // Like session/load, prefer ACP-created mapping first, otherwise scan pi sessions dir.
    // Unlike session/load, ACP session/resume must not replay prior conversation history.
    const stored = this.store.get(params.sessionId)
    const sessionFile = stored?.sessionFile ?? findPiSessionFile(params.sessionId)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    const bridgeRpcHandler = this.createBridgeRpcHandler(params.sessionId)
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        bridgeSetup: this.createBridgeSetup('resume', params.cwd, params.mcpServers ?? [], params.sessionId),
        bridgeRpcHandler
      })
    } catch (e: any) {
      if (e?.name === 'PiRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      conn: this.conn,
      proc,
      fileCommands,
      bridgeRpcHandler,
      promptResourceStore: this.promptResources,
      stopReasonOverrides: this.stopReasonOverrides,
      terminalBackedToolNames: this.terminalBackedToolNames(),
      authMethods: this.authMethods()
    })

    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile
    })

    const models = await getModelState(proc)
    const thinking = await getThinkingState(proc)

    const response = {
      configOptions: toSessionConfigOptions(models, thinking),
      modes: thinking,
      _meta: toPiAcpSessionMeta(null, models)
    }

    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    this.lastSessionCwd = params.cwd

    // Stage mcpServers into the bridge extension for future extension-owned MCP support.
    // Prefer ACP-created mapping first (fast path), otherwise scan pi sessions dir.
    const stored = this.store.get(params.sessionId)
    const sessionFile = stored?.sessionFile ?? findPiSessionFile(params.sessionId)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    // Spawn pi and point it directly at the session file.
    const bridgeRpcHandler = this.createBridgeRpcHandler(params.sessionId)
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        bridgeSetup: this.createBridgeSetup('load', params.cwd, params.mcpServers, params.sessionId),
        bridgeRpcHandler
      })
    } catch (e: any) {
      if (e?.name === 'PiRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands,
      bridgeRpcHandler,
      promptResourceStore: this.promptResources,
      stopReasonOverrides: this.stopReasonOverrides,
      terminalBackedToolNames: this.terminalBackedToolNames(),
      authMethods: this.authMethods()
    })

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile
    })

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const historicToolResultIds = collectHistoricToolResultIds(messages)
    const historicToolCalls = new Map<string, HistoricToolCall>()
    const replayedToolCalls = new Set<string>()

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'user') {
        for (const content of piMessageContentToAcpBlocks(m?.content)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content
            }
          })
        }
      }

      if (role === 'assistant') {
        const rawContent = Array.isArray(m?.content) ? m.content : [m?.content]
        for (const block of rawContent) {
          const toolCall = toHistoricToolCall(block)
          if (toolCall) {
            historicToolCalls.set(toolCall.id, toolCall)
            if (!replayedToolCalls.has(toolCall.id)) {
              await this.conn.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: toolCall.id,
                  title: toolCall.name,
                  kind: toToolKind(toolCall.name),
                  status: historicToolResultIds.has(toolCall.id) ? 'completed' : 'pending',
                  rawInput: toolCall.args
                }
              })
              replayedToolCalls.add(toolCall.id)
            }
            continue
          }

          for (const content of piAssistantContentToAcpBlocks(block)) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content
              }
            })
          }
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)
        const historicToolCall = historicToolCalls.get(toolCallId)

        if (!replayedToolCalls.has(toolCallId)) {
          // Some older pi sessions may only have toolResult rows. Create a synthetic
          // call so the result can still render as a complete ACP tool sequence.
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: historicToolCall?.name ?? toolName,
              kind: toToolKind(historicToolCall?.name ?? toolName),
              status: 'completed',
              rawInput: historicToolCall?.args ?? null,
              rawOutput: m
            }
          })
          replayedToolCalls.add(toolCallId)
        }

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m
          }
        })
      }
    }

    const models = await getModelState(proc)
    const thinking = await getThinkingState(proc)

    const response = {
      configOptions: toSessionConfigOptions(models, thinking),
      modes: thinking,
      _meta: toPiAcpSessionMeta(null, models)
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId)

    if (params.configId === MODEL_CONFIG_ID) {
      if ('type' in params && params.type === 'boolean') {
        throw RequestError.invalidParams(`${MODEL_CONFIG_ID} must be set to a model id`)
      }
      if (typeof params.value !== 'string') {
        throw RequestError.invalidParams(`${MODEL_CONFIG_ID} must be set to a model id`)
      }

      const selected = await this.setSessionModelById(params.sessionId, params.value)

      return {
        configOptions: await getSessionConfigOptions(session.proc, {
          currentModelId: selected.currentModelId
        })
      }
    }

    if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
      if ('type' in params && params.type === 'boolean') {
        throw RequestError.invalidParams(`${THOUGHT_LEVEL_CONFIG_ID} must be set to a thought level id`)
      }
      if (typeof params.value !== 'string') {
        throw RequestError.invalidParams(`${THOUGHT_LEVEL_CONFIG_ID} must be set to a thought level id`)
      }

      const level = String(params.value)
      if (!isThinkingLevel(level)) {
        throw RequestError.invalidParams(`Unknown thought level: ${level}`)
      }

      await session.proc.setThinkingLevel(level)

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: level
        }
      })

      return {
        configOptions: await getSessionConfigOptions(session.proc, {
          currentThinkingLevel: level
        })
      }
    }

    throw RequestError.invalidParams(`Unknown configId: ${params.configId}`)
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const selected = await this.setSessionModelById(params.sessionId, params.modelId)
    const session = this.sessions.get(params.sessionId)

    await this.emitConfigOptionUpdate(params.sessionId, session.proc, {
      currentModelId: selected.currentModelId
    })

    return {}
  }

  private async setSessionModelById(
    sessionId: string,
    modelId: string
  ): Promise<{ provider: string; modelId: string; currentModelId: string }> {
    const session = this.sessions.get(sessionId)
    const selected = await resolveModelSelection(session.proc, modelId)
    await session.proc.setModel(selected.provider, selected.modelId)
    return selected
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    void this.emitConfigOptionUpdate(session.sessionId, session.proc, {
      currentThinkingLevel: mode
    })

    return {}
  }

  private async emitConfigOptionUpdate(
    sessionId: string,
    proc: PiRpcProcess,
    pre?: ConfigStateOverride
  ): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: await getSessionConfigOptions(proc, pre)
      }
    })
  }
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(process.env.HOME ?? '', '.pi', 'agent', 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (best-effort)
  try {
    const settingsPath = join(process.env.HOME ?? '', '.pi', 'agent', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
    const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
    for (const pkg of pkgs) {
      const s = String(pkg)
      if (s.startsWith('npm:')) {
        // Render a two-line bullet structure using markdown indentation.
        extItems.push(`${s}\n  - index.ts`)
      } else {
        extItems.push(s)
      }
    }
  } catch {
    // ignore
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
