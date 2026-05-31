import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { ACP_REFUSAL_HISTORY_RESTORE_METHOD, ACP_RESTORE_REFUSAL_HISTORY_COMMAND } from '../acp/refusal-history.js'
import {
  connectMcpStdioServers,
  type McpBridgeRuntime,
  type McpReadResourceResult,
  type McpResourceListing,
  type McpServerStatus,
  type RegisteredMcpResourceTools,
  type RegisteredMcpTool
} from './mcp-stdio.js'

type ExtensionAPI = {
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => void
  registerCommand?: (
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: unknown) => Promise<void> | void
    }
  ) => void
  registerTool?: (tool: unknown) => void
  getAllTools?: () => Array<{ name?: unknown }>
  events?: {
    emit?: (channel: string, data: unknown) => void
    on?: (channel: string, handler: (data: unknown) => void) => (() => void) | void
  }
}

type BridgeSetup = {
  version?: number
  lifecycle?: string
  cwd?: string
  sessionId?: string | null
  mcpServers?: unknown[]
  clientCapabilities?: unknown
  toolCallPermissions?: {
    enabled?: unknown
    toolNames?: unknown
  }
  adapterRpc?: AdapterRpcEndpoint | null
  createdAt?: string
}

type AdapterRpcEndpoint = {
  host: string
  port: number
  token: string
}

type ReadTextFileOptions = {
  line?: number | null
  limit?: number | null
}

type EnvVariable = {
  name: string
  value: string
}

type CreateTerminalOptions = {
  command: string
  args?: string[]
  env?: EnvVariable[]
  cwd?: string | null
  outputByteLimit?: number | null
}

type TerminalExitStatus = {
  exitCode?: number | null
  signal?: string | null
}

type TerminalOutputResult = {
  output: string
  truncated: boolean
  exitStatus?: TerminalExitStatus | null
}

type TerminalExecutionResult = {
  terminalId: string
  output: string
  truncated: boolean
  exitStatus: TerminalExitStatus | null
}

type ExecuteTerminalOptions = {
  release?: 'after_output' | 'manual'
  signal?: AbortSignal
  timeoutSeconds?: number | null
}

type FileEdit = {
  oldText: string
  newText: string
}

type PromptResourceLink = {
  type: 'resource_link'
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

type PromptResourceReadResult = {
  contents: Array<{
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }>
}

type ToolPermissionRequest = {
  toolCallId: string
  toolName: string
  input: unknown
}

type ToolPermissionResult = {
  allowed: boolean
  reason?: string
  optionId?: string
}

type PlanEntry = {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
  _meta?: Record<string, unknown> | null
}

type PromptStopReason = 'max_turn_requests' | 'refusal'

type SessionEntryLike = {
  id?: unknown
  parentId?: unknown
  type?: unknown
  message?: {
    role?: unknown
  }
}

type SessionManagerLike = {
  getLeafId?: () => string | null
  getSessionId?: () => string
  getEntries?: () => SessionEntryLike[]
}

type ExtensionContextLike = {
  sessionManager?: SessionManagerLike
  navigateTree?: (
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }
  ) => Promise<{ cancelled?: boolean }> | { cancelled?: boolean }
}

type RefusalHistoryTurn = {
  sessionId: string | null
  safeLeafId: string | null
  userEntryId: string | null
}

export type PiAcpBridgeService = {
  type: 'pi-acp-bridge'
  version: 1
  getSetup: () => BridgeSetup
  getPublicSetup: () => Record<string, unknown>
  getMcpServers: () => unknown[]
  getClientCapabilities: () => unknown | null
  getPromptResourceLinks: () => Promise<PromptResourceLink[]>
  readPromptResource: (uri: string) => Promise<PromptResourceReadResult>
  getMcpStatus: () => McpServerStatus[]
  getRegisteredMcpTools: () => RegisteredMcpTool[]
  getRegisteredMcpResourceTools: () => RegisteredMcpResourceTools[]
  getMcpResources: () => McpResourceListing[]
  listMcpResources: (serverName?: string) => Promise<McpResourceListing[]>
  readMcpResource: (serverName: string, uri: string) => Promise<McpReadResourceResult>
  readTextFile: (path: string, options?: ReadTextFileOptions) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
  createTerminal: (params: CreateTerminalOptions) => Promise<{ terminalId: string }>
  terminalOutput: (terminalId: string) => Promise<TerminalOutputResult>
  terminalWaitForExit: (terminalId: string) => Promise<TerminalExitStatus>
  terminalKill: (terminalId: string) => Promise<void>
  terminalRelease: (terminalId: string) => Promise<void>
  executeTerminalCommand: (
    params: CreateTerminalOptions,
    options?: ExecuteTerminalOptions
  ) => Promise<TerminalExecutionResult>
  requestToolPermission: (event: unknown) => Promise<ToolPermissionResult>
  publishPlan: (entries: PlanEntry[]) => Promise<void>
  setPromptStopReason: (stopReason: PromptStopReason, options?: { source?: string }) => Promise<void>
}

export default async function acpBridge(pi: ExtensionAPI): Promise<void> {
  const setup = readSetup(process.env.PI_ACP_BRIDGE_SETUP)
  if (!setup) return

  let mcpRuntime: McpBridgeRuntime | null = null
  const service = createBridgeService(setup, () => mcpRuntime)

  pi.events?.on?.('acp:bridge:request', request => {
    const reply = getReply(request)
    if (reply) reply(service)
  })

  emit(pi, 'acp:bridge:ready', service)
  emit(pi, 'acp:bridge:loaded', service.getPublicSetup())

  pi.registerCommand?.('acp-bridge-status', {
    description: 'Show ACP bridge and MCP status',
    handler: async (_args, ctx) => {
      notify(ctx, formatBridgeStatus(service, pi), 'info')
    }
  })

  pi.registerCommand?.('acp-mcp-read-resource', {
    description: 'Read an MCP resource through the ACP bridge',
    handler: async (args, ctx) => {
      const parsed = parseReadResourceArgs(args)
      if (!parsed) {
        notify(ctx, 'Usage: /acp-mcp-read-resource <server> <uri>', 'error')
        return
      }

      try {
        const result = await service.readMcpResource(parsed.serverName, parsed.uri)
        notify(ctx, formatMcpResourceRead(parsed.serverName, parsed.uri, result), 'info')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        notify(ctx, `MCP resource read failed: ${message}`, 'error')
      }
    }
  })

  pi.registerCommand?.('acp-read-prompt-resource', {
    description: 'Read a prompt resource link through the ACP bridge',
    handler: async (args, ctx) => {
      const uri = args.trim()
      if (!uri) {
        notify(ctx, 'Usage: /acp-read-prompt-resource <uri>', 'error')
        return
      }

      try {
        const result = await service.readPromptResource(uri)
        notify(ctx, formatPromptResourceRead(uri, result), 'info')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        notify(ctx, `ACP prompt resource read failed: ${message}`, 'error')
      }
    }
  })

  registerPromptResourceTools(pi, setup, service)
  registerClientFsTools(pi, setup, service)
  registerClientTerminalTools(pi, setup, service)
  registerToolPermissionHook(pi, setup, service)
  registerRefusalHistoryBridge(pi, setup)

  pi.on?.('session_start', (event, ctx) => {
    emit(pi, 'acp:bridge:session_start', {
      ...service.getPublicSetup(),
      event
    })

    for (const status of service.getMcpStatus().filter(item => item.state !== 'connected')) {
      notify(ctx, `MCP server "${status.name}" ${status.state}: ${status.error ?? 'no tools available'}`, 'error')
    }
  })

  pi.on?.('session_shutdown', () => {
    void mcpRuntime?.close()
  })

  mcpRuntime = await connectMcpStdioServers(setup, pi, {
    emit: (channel, data) => emit(pi, channel, data)
  })

  emit(pi, 'acp:mcp:ready', {
    status: mcpRuntime.getStatus(),
    tools: mcpRuntime.getRegisteredTools()
  })
}

function createBridgeService(setup: BridgeSetup, getMcpRuntime: () => McpBridgeRuntime | null): PiAcpBridgeService {
  return {
    type: 'pi-acp-bridge',
    version: 1,
    getSetup: () => cloneJson(setup),
    getPublicSetup: () => toPublicSetup(setup),
    getMcpServers: () => cloneJson(Array.isArray(setup.mcpServers) ? setup.mcpServers : []),
    getClientCapabilities: () => cloneJson(setup.clientCapabilities ?? null),
    getPromptResourceLinks: async () => {
      if (!isAdapterRpcEndpoint(setup.adapterRpc)) return []
      return normalizePromptResourceList(await callAdapterRpc(setup, 'resource/list_prompt_resource_links', {}))
    },
    readPromptResource: async uri => {
      return normalizePromptResourceReadResult(
        await callAdapterRpc(setup, 'resource/read_prompt_resource', {
          uri: requireString(uri, 'uri')
        })
      )
    },
    getMcpStatus: () => getMcpRuntime()?.getStatus() ?? [],
    getRegisteredMcpTools: () => getMcpRuntime()?.getRegisteredTools() ?? [],
    getRegisteredMcpResourceTools: () => getMcpRuntime()?.getRegisteredResourceTools() ?? [],
    getMcpResources: () => getMcpRuntime()?.getResources() ?? [],
    listMcpResources: serverName => getMcpRuntime()?.listResources(serverName) ?? Promise.resolve([]),
    readMcpResource: (serverName, uri) => {
      const runtime = getMcpRuntime()
      if (!runtime) return Promise.reject(new Error('MCP runtime is not ready'))
      return runtime.readResource(serverName, uri)
    },
    readTextFile: async (path, options) => {
      if (!hasClientFsRead(setup)) throw new Error('ACP client did not advertise fs.readTextFile')
      const result = await callAdapterRpc(setup, 'fs/read_text_file', {
        path,
        ...(options?.line === undefined ? {} : { line: options.line }),
        ...(options?.limit === undefined ? {} : { limit: options.limit })
      })
      const content = (result as { content?: unknown } | null)?.content
      if (typeof content !== 'string') throw new Error('ACP client returned invalid readTextFile response')
      return content
    },
    writeTextFile: async (path, content) => {
      if (!hasClientFsWrite(setup)) throw new Error('ACP client did not advertise fs.writeTextFile')
      await callAdapterRpc(setup, 'fs/write_text_file', { path, content })
    },
    createTerminal: async params => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      return serviceCreateTerminal(setup, params)
    },
    terminalOutput: async terminalId => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      return normalizeTerminalOutput(
        await callAdapterRpc(setup, 'terminal/output', {
          terminalId: requireString(terminalId, 'terminalId')
        })
      )
    },
    terminalWaitForExit: async terminalId => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      return normalizeTerminalExitStatus(
        await callAdapterRpc(setup, 'terminal/wait_for_exit', {
          terminalId: requireString(terminalId, 'terminalId')
        })
      )
    },
    terminalKill: async terminalId => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      await callAdapterRpc(setup, 'terminal/kill', {
        terminalId: requireString(terminalId, 'terminalId')
      })
    },
    terminalRelease: async terminalId => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      await callAdapterRpc(setup, 'terminal/release', {
        terminalId: requireString(terminalId, 'terminalId')
      })
    },
    executeTerminalCommand: async (params, options) => {
      if (!hasClientTerminal(setup)) throw new Error('ACP client did not advertise terminal support')
      const created = await serviceCreateTerminal(setup, params)
      let primaryError: unknown
      let result: TerminalExecutionResult | null = null
      try {
        const waitStatus = await waitForTerminalExit(setup, created.terminalId, options)
        const output = await serviceTerminalOutput(setup, created.terminalId)
        result = {
          terminalId: created.terminalId,
          output: output.output,
          truncated: output.truncated,
          exitStatus: output.exitStatus ?? waitStatus
        }
      } catch (err) {
        primaryError = err
      }

      const releaseError =
        options?.release === 'manual' ? null : await serviceTerminalRelease(setup, created.terminalId).catch(err => err)
      if (primaryError !== undefined) throw primaryError
      if (releaseError) throw releaseError
      if (!result) throw new Error('ACP terminal execution did not produce a result')
      return result
    },
    requestToolPermission: async event => {
      if (!hasToolPermissionBridge(setup)) throw new Error('ACP tool-call permission bridge is not enabled')
      return normalizeToolPermissionResult(
        await callAdapterRpc(setup, 'permission/request_tool_call', normalizeToolPermissionEvent(event))
      )
    },
    publishPlan: async entries => {
      if (!isAdapterRpcEndpoint(setup.adapterRpc)) throw new Error('ACP bridge adapter RPC is not available')
      await callAdapterRpc(setup, 'plan/update', { entries: normalizePlanEntries(entries) })
    },
    setPromptStopReason: async (stopReason, options) => {
      if (!isAdapterRpcEndpoint(setup.adapterRpc)) throw new Error('ACP bridge adapter RPC is not available')
      await callAdapterRpc(setup, 'prompt/set_stop_reason', {
        stopReason: normalizePromptStopReason(stopReason),
        ...(options?.source === undefined ? {} : { source: requireString(options.source, 'source') })
      })
    }
  }
}

function readSetup(setupPath: string | undefined): BridgeSetup | null {
  if (!setupPath) return null

  try {
    const parsed = JSON.parse(readFileSync(setupPath, 'utf8')) as BridgeSetup
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function toPublicSetup(setup: BridgeSetup): Record<string, unknown> {
  return {
    version: setup.version ?? 1,
    lifecycle: setup.lifecycle ?? null,
    cwd: typeof setup.cwd === 'string' ? setup.cwd : null,
    sessionId: typeof setup.sessionId === 'string' ? setup.sessionId : null,
    mcpServerCount: Array.isArray(setup.mcpServers) ? setup.mcpServers.length : 0,
    hasClientCapabilities: setup.clientCapabilities != null,
    hasAdapterRpc: isAdapterRpcEndpoint(setup.adapterRpc),
    createdAt: typeof setup.createdAt === 'string' ? setup.createdAt : null
  }
}

function formatBridgeStatus(service: PiAcpBridgeService, pi: ExtensionAPI): string {
  return `ACP bridge status: ${JSON.stringify({
    publicSetup: service.getPublicSetup(),
    mcpStatus: service.getMcpStatus(),
    registeredMcpTools: service.getRegisteredMcpTools(),
    registeredMcpResourceTools: service.getRegisteredMcpResourceTools(),
    mcpResources: service.getMcpResources(),
    piTools: getPiTools(pi),
    piToolNames: getPiToolNames(pi)
  })}`
}

function parseReadResourceArgs(args: string): { serverName: string; uri: string } | null {
  const trimmed = args.trim()
  const separator = trimmed.search(/\s/)
  if (separator <= 0) return null
  const serverName = trimmed.slice(0, separator).trim()
  const uri = trimmed.slice(separator).trim()
  return serverName && uri ? { serverName, uri } : null
}

function formatMcpResourceRead(serverName: string, uri: string, result: McpReadResourceResult): string {
  return `ACP MCP resource: ${JSON.stringify({
    serverName,
    uri,
    contents: result.contents.map(content => ({
      uri: content.uri,
      mimeType: content.mimeType ?? null,
      type: content.text !== undefined ? 'text' : 'blob',
      text: content.text,
      bytes: typeof content.blob === 'string' ? Buffer.byteLength(content.blob, 'base64') : undefined
    }))
  })}`
}

function formatPromptResourceRead(uri: string, result: PromptResourceReadResult): string {
  return `ACP prompt resource: ${JSON.stringify({
    uri,
    contents: result.contents.map(content => ({
      uri: content.uri,
      mimeType: content.mimeType ?? null,
      type: content.text !== undefined ? 'text' : 'blob',
      text: content.text,
      bytes: typeof content.blob === 'string' ? Buffer.byteLength(content.blob, 'base64') : undefined
    }))
  })}`
}

function registerRefusalHistoryBridge(pi: ExtensionAPI, setup: BridgeSetup): void {
  let latestTurn: RefusalHistoryTurn | null = null

  pi.on?.('before_agent_start', (_event, ctx) => {
    const context = ctx as ExtensionContextLike
    latestTurn = {
      sessionId: getContextSessionId(context),
      safeLeafId: getContextLeafId(context),
      userEntryId: null
    }
  })

  pi.on?.('agent_end', (_event, ctx) => {
    if (!latestTurn) return
    latestTurn.sessionId = latestTurn.sessionId ?? getContextSessionId(ctx as ExtensionContextLike)
    latestTurn.userEntryId = findPromptUserEntryId((ctx as ExtensionContextLike).sessionManager, latestTurn.safeLeafId)
  })

  pi.registerCommand?.(ACP_RESTORE_REFUSAL_HISTORY_COMMAND, {
    description: 'Restore the ACP refusal history boundary',
    handler: async (_args, ctx) => {
      const context = ctx as ExtensionContextLike
      const turn = latestTurn
      const sessionId = turn?.sessionId ?? getContextSessionId(context)
      const userEntryId =
        turn?.userEntryId ??
        findPromptUserEntryId(context.sessionManager, turn?.safeLeafId ?? getContextLeafId(context))

      if (!userEntryId) {
        await reportRefusalHistoryRestore(setup, {
          restored: false,
          reason: 'No user entry was recorded for the refused turn.',
          sessionId,
          safeLeafId: turn?.safeLeafId ?? null,
          userEntryId: null
        })
        return
      }

      if (typeof context.navigateTree !== 'function') {
        await reportRefusalHistoryRestore(setup, {
          restored: false,
          reason: 'pi did not provide command-context tree navigation.',
          sessionId,
          safeLeafId: turn?.safeLeafId ?? null,
          userEntryId
        })
        return
      }

      try {
        const result = await context.navigateTree(userEntryId, { summarize: false })
        const restored = result?.cancelled !== true
        await reportRefusalHistoryRestore(setup, {
          restored,
          ...(restored ? {} : { reason: 'Refusal history navigation was cancelled.' }),
          sessionId,
          safeLeafId: turn?.safeLeafId ?? null,
          userEntryId
        })
      } catch (err) {
        await reportRefusalHistoryRestore(setup, {
          restored: false,
          reason: err instanceof Error ? err.message : String(err),
          sessionId,
          safeLeafId: turn?.safeLeafId ?? null,
          userEntryId
        })
      }
    }
  })
}

function getContextSessionId(ctx: ExtensionContextLike): string | null {
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.()
    return typeof sessionId === 'string' && sessionId ? sessionId : null
  } catch {
    return null
  }
}

function getContextLeafId(ctx: ExtensionContextLike): string | null {
  try {
    const leafId = ctx.sessionManager?.getLeafId?.()
    return typeof leafId === 'string' && leafId ? leafId : null
  } catch {
    return null
  }
}

function findPromptUserEntryId(
  sessionManager: SessionManagerLike | undefined,
  safeLeafId: string | null
): string | null {
  let entries: SessionEntryLike[]
  try {
    entries = sessionManager?.getEntries?.() ?? []
  } catch {
    entries = []
  }

  if (!Array.isArray(entries) || entries.length === 0) return null

  const startIndex = safeLeafId === null ? 0 : Math.max(0, entries.findIndex(entry => entry.id === safeLeafId) + 1)

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry?.type !== 'message') continue
    if (entry.message?.role !== 'user') continue
    const parentId = entry.parentId
    if (safeLeafId === null ? parentId !== null : parentId !== safeLeafId) continue
    return typeof entry.id === 'string' && entry.id ? entry.id : null
  }

  return null
}

async function reportRefusalHistoryRestore(
  setup: BridgeSetup,
  result: {
    restored: boolean
    reason?: string
    sessionId?: string | null
    safeLeafId?: string | null
    userEntryId?: string | null
  }
): Promise<void> {
  if (!isAdapterRpcEndpoint(setup.adapterRpc)) return

  await callAdapterRpc(setup, ACP_REFUSAL_HISTORY_RESTORE_METHOD, {
    restored: result.restored,
    source: 'pi-acp-bridge',
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.sessionId === undefined || result.sessionId === null ? {} : { sessionId: result.sessionId }),
    ...(result.safeLeafId === undefined ? {} : { safeLeafId: result.safeLeafId }),
    ...(result.userEntryId === undefined ? {} : { userEntryId: result.userEntryId })
  }).catch(() => {
    // Best effort. The adapter also gates command invocation through get_commands.
  })
}

function normalizePromptResourceList(value: unknown): PromptResourceLink[] {
  const raw = ensureObject(value)
  const resources = raw.resources
  if (!Array.isArray(resources)) throw new Error('ACP bridge returned invalid prompt resource list')
  return resources.map((resource, index) => normalizePromptResourceLink(resource, index))
}

function normalizePromptResourceLink(value: unknown, index: number): PromptResourceLink {
  const raw = ensureObject(value)
  const uri = requireString(raw.uri, `resources[${index}].uri`)
  const name = requireString(raw.name, `resources[${index}].name`)
  const title = optionalString(raw.title, `resources[${index}].title`)
  const description = optionalString(raw.description, `resources[${index}].description`)
  const mimeType = optionalString(raw.mimeType, `resources[${index}].mimeType`)
  const size = optionalNumber(raw.size, `resources[${index}].size`)

  return {
    type: 'resource_link',
    uri,
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(size === undefined || size === null ? {} : { size })
  }
}

function normalizePromptResourceReadResult(value: unknown): PromptResourceReadResult {
  const raw = ensureObject(value)
  const contents = raw.contents
  if (!Array.isArray(contents)) throw new Error('ACP bridge returned invalid prompt resource contents')

  return {
    contents: contents.map((content, index) => {
      const item = ensureObject(content)
      const uri = requireString(item.uri, `contents[${index}].uri`)
      const mimeType = optionalString(item.mimeType, `contents[${index}].mimeType`)
      const text = optionalString(item.text, `contents[${index}].text`)
      const blob = optionalString(item.blob, `contents[${index}].blob`)
      if (text === undefined && blob === undefined) {
        throw new Error(`contents[${index}] must include text or blob`)
      }

      return {
        uri,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(text === undefined ? {} : { text }),
        ...(blob === undefined ? {} : { blob })
      }
    })
  }
}

function registerPromptResourceTools(pi: ExtensionAPI, setup: BridgeSetup, service: PiAcpBridgeService): void {
  if (!pi.registerTool || !isAdapterRpcEndpoint(setup.adapterRpc)) return

  pi.registerTool({
    name: 'acp_list_prompt_resources',
    label: 'ACP prompt resources: list',
    description: 'List ACP prompt resource links available during the current prompt turn.',
    promptSnippet: 'List ACP prompt resource links provided by the client for this turn.',
    promptGuidelines: ['Use acp_list_prompt_resources when the user references attached or linked prompt context.'],
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    executionMode: 'parallel',
    execute: async () => {
      const resources = await service.getPromptResourceLinks()
      return {
        content: [{ type: 'text', text: JSON.stringify(resources, null, 2) }],
        details: { source: 'acp-prompt-resources', count: resources.length }
      }
    }
  })

  pi.registerTool({
    name: 'acp_read_prompt_resource',
    label: 'ACP prompt resources: read',
    description: 'Read an ACP prompt resource link by URI.',
    promptSnippet: 'Read an ACP prompt resource link.',
    promptGuidelines: ['Call acp_list_prompt_resources first if you do not know the exact resource URI.'],
    parameters: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'Resource URI from a prompt resource_link content block.' }
      },
      required: ['uri'],
      additionalProperties: false
    },
    executionMode: 'parallel',
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const uri = requireString(params.uri, 'uri')
      const result = await service.readPromptResource(uri)
      return {
        content: [{ type: 'text', text: formatPromptResourceToolText(result) }],
        details: { source: 'acp-prompt-resources', uri, contents: result.contents }
      }
    }
  })
}

function formatPromptResourceToolText(result: PromptResourceReadResult): string {
  if (result.contents.length === 1 && typeof result.contents[0]!.text === 'string') {
    return result.contents[0]!.text!
  }

  return JSON.stringify(
    result.contents.map(content => ({
      uri: content.uri,
      mimeType: content.mimeType ?? null,
      text: content.text,
      bytes: typeof content.blob === 'string' ? Buffer.byteLength(content.blob, 'base64') : undefined
    })),
    null,
    2
  )
}

function registerClientFsTools(pi: ExtensionAPI, setup: BridgeSetup, service: PiAcpBridgeService): void {
  if (!pi.registerTool) return
  const canRead = hasClientFsRead(setup)
  const canWrite = hasClientFsWrite(setup)

  if (canRead) {
    pi.registerTool({
      name: 'acp_read_text_file',
      label: 'ACP client: read text file',
      description:
        'Read text from the ACP client filesystem, including editor-managed unsaved state when the client supports it.',
      promptSnippet: 'Read a text file through the ACP client filesystem.',
      promptGuidelines: ['Use acp_read_text_file when the ACP client filesystem should be authoritative.'],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to read.' },
          line: { type: 'number', description: 'Optional 1-based line number to start at.' },
          limit: { type: 'number', description: 'Optional maximum number of lines to read.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      executionMode: 'parallel',
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const path = requireString(params.path, 'path')
        const line = optionalNumber(params.line, 'line')
        const limit = optionalNumber(params.limit, 'limit')
        const resolvedPath = resolveClientPath(setup, path)
        const content = await service.readTextFile(resolvedPath, { line, limit })
        return {
          content: [{ type: 'text', text: content }],
          details: { path: resolvedPath, line: line ?? null, limit: limit ?? null, source: 'acp-client-fs' }
        }
      }
    })

    pi.registerTool({
      name: 'read',
      label: 'read',
      description:
        'Read file contents through the ACP client filesystem, including editor-managed unsaved state when the client supports it.',
      promptSnippet: 'Read file contents',
      promptGuidelines: ['Use read to examine files instead of cat or sed.'],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read (relative or absolute).' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed).' },
          limit: { type: 'number', description: 'Maximum number of lines to read.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      executionMode: 'parallel',
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const path = requireString(params.path, 'path')
        const offset = optionalNumber(params.offset, 'offset')
        const limit = optionalNumber(params.limit, 'limit')
        const resolvedPath = resolveClientPath(setup, path)
        const content = await service.readTextFile(resolvedPath, { line: offset, limit })
        return {
          content: [{ type: 'text', text: content }],
          details: {
            path: resolvedPath,
            offset: offset ?? null,
            limit: limit ?? null,
            source: 'acp-client-fs',
            tool: 'read'
          }
        }
      }
    })
  }

  if (canWrite) {
    pi.registerTool({
      name: 'acp_write_text_file',
      label: 'ACP client: write text file',
      description: 'Write text to the ACP client filesystem.',
      promptSnippet: 'Write a text file through the ACP client filesystem.',
      promptGuidelines: ['Use acp_write_text_file when writes must go through the ACP client filesystem.'],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to write.' },
          content: { type: 'string', description: 'Text content to write.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      executionMode: 'sequential',
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const path = requireString(params.path, 'path')
        const content = requireString(params.content, 'content')
        const resolvedPath = resolveClientPath(setup, path)
        await service.writeTextFile(resolvedPath, content)
        return {
          content: [
            {
              type: 'text',
              text: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes through ACP client fs: ${resolvedPath}`
            }
          ],
          details: { path: resolvedPath, bytes: Buffer.byteLength(content, 'utf8'), source: 'acp-client-fs' }
        }
      }
    })

    pi.registerTool({
      name: 'write',
      label: 'write',
      description: 'Create or overwrite files through the ACP client filesystem.',
      promptSnippet: 'Create or overwrite files',
      promptGuidelines: ['Use write only for new files or complete rewrites.'],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write (relative or absolute).' },
          content: { type: 'string', description: 'Content to write to the file.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      executionMode: 'sequential',
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const path = requireString(params.path, 'path')
        const content = requireString(params.content, 'content')
        const resolvedPath = resolveClientPath(setup, path)
        const oldText = canRead ? await readClientTextOrNull(service, resolvedPath) : undefined

        await service.writeTextFile(resolvedPath, content)

        const details: Record<string, unknown> = {
          path: resolvedPath,
          bytes: Buffer.byteLength(content, 'utf8'),
          source: 'acp-client-fs',
          tool: 'write'
        }
        if (oldText !== undefined) {
          details.oldText = oldText
          details.newText = content
        }

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${resolvedPath}.`
            }
          ],
          details
        }
      }
    })
  }

  if (canRead && canWrite) {
    pi.registerTool({
      name: 'edit',
      label: 'edit',
      description:
        'Edit a single file through the ACP client filesystem using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.',
      promptSnippet:
        'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      promptGuidelines: [
        'Use edit for precise changes (edits[].oldText must match exactly)',
        'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
        'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
        'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.'
      ],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit (relative or absolute).' },
          edits: {
            type: 'array',
            description:
              'One or more targeted replacements. Each edit is matched against the original file, not incrementally.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text for one targeted replacement.' },
                newText: { type: 'string', description: 'Replacement text for this targeted edit.' }
              },
              required: ['oldText', 'newText'],
              additionalProperties: false
            }
          }
        },
        required: ['path', 'edits'],
        additionalProperties: false
      },
      executionMode: 'sequential',
      prepareArguments: prepareEditArguments,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const path = requireString(params.path, 'path')
        const edits = normalizeFileEdits(params.edits)
        const resolvedPath = resolveClientPath(setup, path)
        const oldText = await service.readTextFile(resolvedPath)
        const newText = applyExactFileEdits(oldText, edits, path)

        await service.writeTextFile(resolvedPath, newText)

        return {
          content: [{ type: 'text', text: `Successfully replaced ${edits.length} block(s) in ${resolvedPath}.` }],
          details: {
            path: resolvedPath,
            oldText,
            newText,
            source: 'acp-client-fs',
            tool: 'edit'
          }
        }
      }
    })
  }
}

function resolveClientPath(setup: BridgeSetup, path: string): string {
  if (isAbsolute(path)) return path
  const cwd = typeof setup.cwd === 'string' && setup.cwd ? setup.cwd : process.cwd()
  return resolvePath(cwd, path)
}

async function readClientTextOrNull(service: PiAcpBridgeService, path: string): Promise<string | null> {
  try {
    return await service.readTextFile(path)
  } catch {
    return null
  }
}

function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  const args = input as Record<string, unknown>
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      // Leave invalid JSON in place; normal validation will report edits as invalid.
    }
  }

  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') return args

  const edits = Array.isArray(args.edits) ? [...args.edits] : []
  edits.push({ oldText: args.oldText, newText: args.newText })
  const { oldText: _oldText, newText: _newText, ...rest } = args
  return { ...rest, edits }
}

function normalizeFileEdits(value: unknown): FileEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
  }

  return value.map((item, index) => {
    const raw = ensureObject(item)
    return {
      oldText: requireString(raw.oldText, `edits[${index}].oldText`),
      newText: requireStringAllowEmpty(raw.newText, `edits[${index}].newText`)
    }
  })
}

function applyExactFileEdits(content: string, edits: FileEdit[], path: string): string {
  const ranges = edits.map((edit, index) => {
    const start = content.indexOf(edit.oldText)
    if (start < 0) throw new Error(`Could not edit file: ${path}. edits[${index}].oldText was not found.`)

    const second = content.indexOf(edit.oldText, start + edit.oldText.length)
    if (second >= 0) {
      throw new Error(`Could not edit file: ${path}. edits[${index}].oldText matches more than once.`)
    }

    return {
      index,
      start,
      end: start + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText
    }
  })

  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(
        `Could not edit file: ${path}. edits[${sorted[i - 1]!.index}] and edits[${sorted[i]!.index}] overlap.`
      )
    }
  }

  let result = content
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, range.start) + range.newText + result.slice(range.end)
  }
  return result
}

function registerClientTerminalTools(pi: ExtensionAPI, setup: BridgeSetup, service: PiAcpBridgeService): void {
  if (!pi.registerTool || !hasClientTerminal(setup)) return

  pi.registerTool({
    name: 'acp_terminal_execute',
    label: 'ACP client: execute terminal command',
    description: 'Run a command in an ACP client-owned terminal when the client supports terminal delegation.',
    promptSnippet: 'Execute a shell command through the ACP client terminal.',
    promptGuidelines: [
      'Use acp_terminal_execute when terminal execution should be owned by the ACP client.',
      'Prefer explicit command arguments over shell interpolation.'
    ],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command executable to run.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional command arguments.' },
        cwd: { type: 'string', description: 'Optional absolute working directory.' },
        env: {
          description: 'Optional environment variables as an object map or an ACP [{name,value}] array.'
        },
        outputByteLimit: {
          type: 'number',
          description: 'Optional maximum terminal output bytes retained by the ACP client.'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const request = normalizeTerminalToolParams(params)
      const result = await service.executeTerminalCommand(request, { release: 'manual' })
      return {
        content: [{ type: 'text', text: formatTerminalExecutionText(result) }],
        details: {
          terminalId: result.terminalId,
          command: request.command,
          args: request.args ?? [],
          cwd: request.cwd ?? null,
          outputByteLimit: request.outputByteLimit ?? null,
          output: result.output,
          truncated: result.truncated,
          exitStatus: result.exitStatus,
          terminalRelease: 'pi-acp-after-tool-call-update',
          source: 'acp-client-terminal'
        }
      }
    }
  })

  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description:
      'Execute a bash command in the current working directory through the ACP client terminal. Returns stdout and stderr.',
    promptSnippet: 'Execute bash commands (ls, grep, find, etc.)',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' }
      },
      required: ['command'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      const command = requireString(params.command, 'command')
      const timeout = optionalNumber(params.timeout, 'timeout')
      const shell = terminalShellCommand(command)
      const result = await service.executeTerminalCommand(
        {
          command: shell.command,
          args: shell.args,
          cwd: typeof setup.cwd === 'string' ? setup.cwd : undefined
        },
        { release: 'manual', signal, timeoutSeconds: timeout }
      )

      return {
        content: [{ type: 'text', text: formatTerminalExecutionText(result) }],
        details: {
          terminalId: result.terminalId,
          command,
          shellCommand: shell.command,
          shellArgs: shell.args,
          cwd: typeof setup.cwd === 'string' ? setup.cwd : null,
          timeout: timeout ?? null,
          output: result.output,
          truncated: result.truncated,
          exitStatus: result.exitStatus,
          terminalRelease: 'pi-acp-after-tool-call-update',
          source: 'acp-client-terminal',
          tool: 'bash'
        }
      }
    }
  })
}

function registerToolPermissionHook(pi: ExtensionAPI, setup: BridgeSetup, service: PiAcpBridgeService): void {
  if (!pi.on || !hasToolPermissionBridge(setup)) return

  pi.on('tool_call', async event => {
    if (!shouldRequestToolPermission(setup, event)) return undefined

    try {
      const result = await service.requestToolPermission(event)
      if (result.allowed) return undefined
      return { block: true, reason: result.reason ?? 'Rejected by ACP client' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { block: true, reason: `ACP permission request failed: ${message}` }
    }
  })
}

function hasToolPermissionBridge(setup: BridgeSetup): boolean {
  return isAdapterRpcEndpoint(setup.adapterRpc) && getToolPermissionConfig(setup).enabled === true
}

function shouldRequestToolPermission(setup: BridgeSetup, event: unknown): boolean {
  const request = maybeToolPermissionEvent(event)
  if (!request) return false

  const toolNames = getToolPermissionConfig(setup).toolNames
  return toolNames.includes('*') || toolNames.includes(request.toolName)
}

function getToolPermissionConfig(setup: BridgeSetup): { enabled: boolean; toolNames: string[] } {
  const raw = (setup as { toolCallPermissions?: unknown }).toolCallPermissions
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false, toolNames: [] }
  const enabled = (raw as { enabled?: unknown }).enabled === true
  const toolNames = Array.isArray((raw as { toolNames?: unknown }).toolNames)
    ? (raw as { toolNames: unknown[] }).toolNames.filter(
        (name): name is string => typeof name === 'string' && name.length > 0
      )
    : []
  return { enabled, toolNames }
}

function maybeToolPermissionEvent(event: unknown): ToolPermissionRequest | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const raw = event as Record<string, unknown>
  if (raw.type !== 'tool_call') return null
  if (typeof raw.toolCallId !== 'string' || !raw.toolCallId) return null
  if (typeof raw.toolName !== 'string' || !raw.toolName) return null
  return {
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    input: raw.input ?? null
  }
}

function normalizeToolPermissionEvent(event: unknown): ToolPermissionRequest {
  const request = maybeToolPermissionEvent(event)
  if (!request) throw new Error('tool_call event is invalid')
  return request
}

function normalizeToolPermissionResult(value: unknown): ToolPermissionResult {
  const raw = ensureObject(value)
  if (typeof raw.allowed !== 'boolean') throw new Error('ACP permission bridge returned invalid allowed flag')
  const reason = optionalString(raw.reason, 'reason')
  const optionId = optionalString(raw.optionId, 'optionId')
  return {
    allowed: raw.allowed,
    ...(reason === undefined ? {} : { reason }),
    ...(optionId === undefined ? {} : { optionId })
  }
}

function normalizePlanEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) throw new Error('entries must be an array')
  return value.map((entry, index) => normalizePlanEntry(entry, index))
}

function normalizePlanEntry(value: unknown, index: number): PlanEntry {
  const raw = ensureObject(value)
  const priority = raw.priority
  const status = raw.status
  if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    throw new Error(`entries[${index}].priority must be high, medium, or low`)
  }
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
    throw new Error(`entries[${index}].status must be pending, in_progress, or completed`)
  }

  const meta = raw._meta
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw new Error(`entries[${index}]._meta must be an object or null`)
  }

  return {
    content: requireStringAllowEmpty(raw.content, `entries[${index}].content`),
    priority,
    status,
    ...(meta === undefined ? {} : { _meta: meta as Record<string, unknown> | null })
  }
}

function normalizePromptStopReason(value: unknown): PromptStopReason {
  if (value === 'max_turn_requests' || value === 'refusal') return value
  throw new Error('stopReason must be max_turn_requests or refusal')
}

function hasClientFsRead(setup: BridgeSetup): boolean {
  return getClientFs(setup)?.readTextFile === true && isAdapterRpcEndpoint(setup.adapterRpc)
}

function hasClientFsWrite(setup: BridgeSetup): boolean {
  return getClientFs(setup)?.writeTextFile === true && isAdapterRpcEndpoint(setup.adapterRpc)
}

function getClientFs(setup: BridgeSetup): { readTextFile?: unknown; writeTextFile?: unknown } | null {
  const capabilities = setup.clientCapabilities
  if (!capabilities || typeof capabilities !== 'object') return null
  const fs = (capabilities as { fs?: unknown }).fs
  return fs && typeof fs === 'object' ? (fs as { readTextFile?: unknown; writeTextFile?: unknown }) : null
}

function hasClientTerminal(setup: BridgeSetup): boolean {
  const capabilities = setup.clientCapabilities
  return Boolean(
    capabilities &&
    typeof capabilities === 'object' &&
    (capabilities as { terminal?: unknown }).terminal === true &&
    isAdapterRpcEndpoint(setup.adapterRpc)
  )
}

async function serviceCreateTerminal(
  setup: BridgeSetup,
  params: CreateTerminalOptions
): Promise<{ terminalId: string }> {
  const request = normalizeCreateTerminalOptions(params)
  const result = await callAdapterRpc(setup, 'terminal/create', request)
  const terminalId = (result as { terminalId?: unknown } | null)?.terminalId
  if (typeof terminalId !== 'string' || !terminalId) throw new Error('ACP client returned invalid terminal response')
  return { terminalId }
}

async function serviceTerminalOutput(setup: BridgeSetup, terminalId: string): Promise<TerminalOutputResult> {
  return normalizeTerminalOutput(
    await callAdapterRpc(setup, 'terminal/output', {
      terminalId: requireString(terminalId, 'terminalId')
    })
  )
}

async function serviceTerminalWaitForExit(setup: BridgeSetup, terminalId: string): Promise<TerminalExitStatus> {
  return normalizeTerminalExitStatus(
    await callAdapterRpc(setup, 'terminal/wait_for_exit', {
      terminalId: requireString(terminalId, 'terminalId')
    })
  )
}

async function serviceTerminalKill(setup: BridgeSetup, terminalId: string): Promise<void> {
  await callAdapterRpc(setup, 'terminal/kill', {
    terminalId: requireString(terminalId, 'terminalId')
  })
}

async function serviceTerminalRelease(setup: BridgeSetup, terminalId: string): Promise<void> {
  await callAdapterRpc(setup, 'terminal/release', {
    terminalId: requireString(terminalId, 'terminalId')
  })
}

async function waitForTerminalExit(
  setup: BridgeSetup,
  terminalId: string,
  options: ExecuteTerminalOptions | undefined
): Promise<TerminalExitStatus> {
  const timeoutSeconds = options?.timeoutSeconds
  const signal = options?.signal
  if ((timeoutSeconds === undefined || timeoutSeconds === null || timeoutSeconds <= 0) && !signal) {
    return serviceTerminalWaitForExit(setup, terminalId)
  }

  let timedOut = false
  let aborted = false
  let timeout: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined

  const interruptedStatus = () => ({
    exitCode: null,
    signal: timedOut ? 'timeout' : aborted ? 'aborted' : null
  })

  const wait = serviceTerminalWaitForExit(setup, terminalId).catch(err => {
    if (timedOut || aborted) return interruptedStatus()
    throw err
  })

  const interrupts: Promise<TerminalExitStatus>[] = []
  if (typeof timeoutSeconds === 'number' && timeoutSeconds > 0) {
    interrupts.push(
      new Promise(resolve => {
        timeout = setTimeout(() => {
          timedOut = true
          resolve(interruptedStatus())
        }, timeoutSeconds * 1000)
        timeout.unref?.()
      })
    )
  }

  if (signal) {
    interrupts.push(
      new Promise(resolve => {
        if (signal.aborted) {
          aborted = true
          resolve(interruptedStatus())
          return
        }

        abortListener = () => {
          aborted = true
          resolve(interruptedStatus())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      })
    )
  }

  try {
    const status = await Promise.race([wait, ...interrupts])
    if (timedOut || aborted) await serviceTerminalKill(setup, terminalId).catch(() => undefined)
    return status
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function normalizeCreateTerminalOptions(params: CreateTerminalOptions): CreateTerminalOptions {
  const raw = ensureObject(params)
  const command = requireString(raw.command, 'command')
  const args = optionalStringArray(raw.args, 'args')
  const env = optionalEnv(raw.env)
  const cwd = optionalAbsolutePath(raw.cwd, 'cwd')
  const outputByteLimit = optionalNumber(raw.outputByteLimit, 'outputByteLimit')

  return {
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(outputByteLimit === undefined ? {} : { outputByteLimit })
  }
}

function normalizeTerminalToolParams(params: Record<string, unknown>): CreateTerminalOptions {
  const command = requireString(params.command, 'command')
  const args = optionalStringArray(params.args, 'args')
  const env = normalizeTerminalToolEnv(params.env)
  const cwd = optionalAbsolutePath(params.cwd, 'cwd')
  const outputByteLimit = optionalNumber(params.outputByteLimit, 'outputByteLimit')

  return {
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(outputByteLimit === undefined ? {} : { outputByteLimit })
  }
}

function normalizeTerminalToolEnv(value: unknown): EnvVariable[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return optionalEnv(value)
  if (!value || typeof value !== 'object') throw new Error('env must be an object or an array of {name,value} objects')

  return Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
    if (!name) throw new Error('env variable names must be non-empty strings')
    if (typeof raw !== 'string') throw new Error(`env.${name} must be a string`)
    return { name, value: raw }
  })
}

function optionalEnv(value: unknown): EnvVariable[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('env must be an array of {name,value} objects')

  return value.map((item, index) => {
    const raw = ensureObject(item)
    return {
      name: requireString(raw.name, `env[${index}].name`),
      value: requireEnvValue(raw.value, `env[${index}].value`)
    }
  })
}

function normalizeTerminalOutput(value: unknown): TerminalOutputResult {
  const raw = ensureObject(value)
  if (typeof raw.output !== 'string') throw new Error('ACP client returned invalid terminal output')
  if (typeof raw.truncated !== 'boolean') throw new Error('ACP client returned invalid terminal truncation flag')

  return {
    output: raw.output,
    truncated: raw.truncated,
    ...(raw.exitStatus === undefined
      ? {}
      : { exitStatus: raw.exitStatus === null ? null : normalizeTerminalExitStatus(raw.exitStatus) })
  }
}

function normalizeTerminalExitStatus(value: unknown): TerminalExitStatus {
  const raw = ensureObject(value)
  const exitCode = optionalExitCode(raw.exitCode)
  const signal = optionalSignal(raw.signal)
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal })
  }
}

function formatTerminalExecutionText(result: TerminalExecutionResult): string {
  const status = result.exitStatus ?? {}
  const exit = status.exitCode === undefined ? 'unknown' : status.exitCode === null ? 'null' : String(status.exitCode)
  const signal = status.signal ? `, signal=${status.signal}` : ''
  const suffix = result.truncated ? '\n[terminal output truncated]' : ''
  if (result.output) return `${result.output}${suffix}`
  return `(no terminal output; exitCode=${exit}${signal})`
}

function terminalShellCommand(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }

  return { command: process.env.SHELL || 'bash', args: ['-lc', command] }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value
}

function optionalAbsolutePath(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute: ${value}`)
  return value
}

function optionalExitCode(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('exitCode must be an integer')
  return value
}

function optionalSignal(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('signal must be a string')
  return value
}

function isAdapterRpcEndpoint(value: unknown): value is AdapterRpcEndpoint {
  if (!value || typeof value !== 'object') return false
  const endpoint = value as Partial<AdapterRpcEndpoint>
  return typeof endpoint.host === 'string' && typeof endpoint.port === 'number' && typeof endpoint.token === 'string'
}

function callAdapterRpc(setup: BridgeSetup, method: string, params: unknown): Promise<unknown> {
  const endpoint = setup.adapterRpc
  if (!isAdapterRpcEndpoint(endpoint)) throw new Error('ACP bridge adapter RPC is not available')

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const message = { id, token: endpoint.token, method, params }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`ACP bridge adapter RPC timed out: ${method}`))
    }, 10_000)
    timer.unref?.()

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('connect', onConnect)
    }
    const onConnect = () => {
      socket.write(JSON.stringify(message) + '\n')
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index < 0) return

      const line = buffer.slice(0, index).trim()
      cleanup()
      socket.end()

      try {
        const response = JSON.parse(line) as { result?: unknown; error?: { message?: unknown } }
        if (response.error) {
          reject(new Error(String(response.error.message ?? 'ACP bridge adapter RPC failed')))
          return
        }
        resolve(response.result)
      } catch (err) {
        reject(err)
      }
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.on('data', onData)
  })
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  return value
}

function requireStringAllowEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function requireEnvValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalNumber(value: unknown, name: string): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function getPiToolNames(pi: ExtensionAPI): string[] {
  return getPiTools(pi)
    .map(tool => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function getPiTools(pi: ExtensionAPI): Array<{ name?: unknown; sourceInfo?: unknown }> {
  try {
    return (pi.getAllTools?.() ?? []).map(tool => ({
      name: tool.name,
      sourceInfo: (tool as { sourceInfo?: unknown }).sourceInfo
    }))
  } catch {
    return []
  }
}

function getReply(request: unknown): ((service: PiAcpBridgeService) => void) | null {
  if (!request || typeof request !== 'object') return null
  const reply = (request as { reply?: unknown }).reply
  return typeof reply === 'function' ? (reply as (service: PiAcpBridgeService) => void) : null
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function emit(pi: ExtensionAPI, channel: string, data: unknown): void {
  try {
    pi.events?.emit?.(channel, data)
  } catch {
    // Extension bus notifications are advisory; never break pi startup.
  }
}

function notify(ctx: unknown, message: string, type: 'info' | 'warning' | 'error'): void {
  try {
    const ui = (ctx as { ui?: { notify?: (message: string, type?: string) => void } } | null)?.ui
    ui?.notify?.(message, type)
  } catch {
    // Advisory only.
  }
}
