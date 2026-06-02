import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'

const MCP_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_TIMEOUT_MS = 10_000

type ExtensionAPI = {
  getActiveTools?: () => string[]
  registerTool?: (tool: {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    parameters: Record<string, unknown>
    executionMode?: 'sequential' | 'parallel'
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (partial: { content: PiToolContent[]; details: unknown }) => void,
      ctx?: unknown
    ) => Promise<{ content: PiToolContent[]; details: unknown }>
  }) => void
  setActiveTools?: (toolNames: string[]) => void
}

export type BridgeSetupForMcp = {
  cwd?: string
  mcpServers?: unknown[]
}

export type StdioMcpServerConfig = {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

type JsonRpcId = string | number

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

type McpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

type McpInitializeResult = {
  capabilities?: {
    tools?: unknown
    resources?: unknown
  }
}

type McpCallToolResult = {
  content?: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpResource = {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export type McpResourceContent = {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export type McpReadResourceResult = {
  contents: McpResourceContent[]
}

export type McpResourceListing = {
  serverName: string
  resources: McpResource[]
}

type PiToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type RegisteredMcpTool = {
  serverName: string
  mcpToolName: string
  piToolName: string
}

export type RegisteredMcpResourceTools = {
  serverName: string
  listToolName: string
  readToolName: string
}

export type McpServerStatus = {
  name: string
  state: 'connected' | 'failed' | 'unsupported'
  toolCount: number
  resourceCount?: number
  error?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: NodeJS.Timeout
  abort?: () => void
}

type ConnectOptions = {
  timeoutMs?: number
  emit?: (channel: string, data: unknown) => void
}

export class McpBridgeRuntime {
  private readonly clients: McpStdioClient[] = []
  private readonly clientsByServer = new Map<string, McpStdioClient>()
  private readonly statuses: McpServerStatus[] = []
  private readonly registeredTools: RegisteredMcpTool[] = []
  private readonly registeredResourceTools: RegisteredMcpResourceTools[] = []
  private readonly resourcesByServer = new Map<string, McpResource[]>()
  private readonly resourceServerNames = new Set<string>()
  private readonly toolNames = new Set<string>()
  private readonly piToolNamesByMcpTool = new Map<string, string>()
  private readonly refreshTasks = new Map<string, Promise<void>>()
  private readonly resourceRefreshTasks = new Map<string, Promise<void>>()

  constructor(
    private readonly setup: BridgeSetupForMcp,
    private readonly options: ConnectOptions = {}
  ) {}

  async connect(pi: ExtensionAPI): Promise<void> {
    const servers = normalizeStdioMcpServers(this.setup)
    for (const server of servers.unsupported) {
      this.recordStatus({
        name: server.name,
        state: 'unsupported',
        toolCount: 0,
        error: `${server.transport} MCP transport is not advertised or implemented by pi-acp`
      })
    }

    await Promise.all(servers.stdio.map(server => this.connectOne(pi, server)))
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(client => client.close()))
    this.clients.splice(0, this.clients.length)
    this.clientsByServer.clear()
    this.resourcesByServer.clear()
    this.resourceServerNames.clear()
  }

  getStatus(): McpServerStatus[] {
    return cloneJson(this.statuses)
  }

  getRegisteredTools(): RegisteredMcpTool[] {
    return cloneJson(this.registeredTools)
  }

  getRegisteredResourceTools(): RegisteredMcpResourceTools[] {
    return cloneJson(this.registeredResourceTools)
  }

  getResources(): McpResourceListing[] {
    return Array.from(this.resourcesByServer.entries()).map(([serverName, resources]) => ({
      serverName,
      resources: cloneJson(resources)
    }))
  }

  async listResources(serverName?: string): Promise<McpResourceListing[]> {
    const serverNames = serverName ? [serverName] : Array.from(this.resourceServerNames)
    const listings: McpResourceListing[] = []

    for (const name of serverNames) {
      const client = this.clientsByServer.get(name)
      if (!client) {
        if (serverName) throw new Error(`MCP server is not connected: ${name}`)
        continue
      }
      if (!this.resourceServerNames.has(name)) throw new Error(`MCP server does not advertise resources: ${name}`)
      const resources = await client.listResources()
      this.resourcesByServer.set(name, resources)
      this.updateStatusResourceCount(name, resources.length)
      listings.push({ serverName: name, resources: cloneJson(resources) })
    }

    return listings
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const client = this.clientsByServer.get(serverName)
    if (!client) throw new Error(`MCP server is not connected: ${serverName}`)
    if (!this.resourceServerNames.has(serverName))
      throw new Error(`MCP server does not advertise resources: ${serverName}`)
    if (!uri || typeof uri !== 'string') throw new Error('MCP resource uri is required')
    return client.readResource(uri, signal)
  }

  private async connectOne(pi: ExtensionAPI, server: StdioMcpServerConfig): Promise<void> {
    const client = new McpStdioClient(server, {
      timeoutMs: this.options.timeoutMs,
      onNotification: notification => {
        this.options.emit?.('acp:mcp:notification', {
          serverName: server.name,
          notification
        })
        if (isToolsListChangedNotification(notification)) {
          void this.refreshTools(pi, client, server)
        }
        if (isResourcesListChangedNotification(notification)) {
          void this.refreshResources(client, server)
        }
      }
    })

    try {
      await client.start()
      const initializeResult = await client.initialize()
      const tools = hasToolsCapability(initializeResult) ? await client.listTools() : []
      for (const tool of tools) this.registerTool(pi, client, server, tool)
      let resourceCount: number | undefined
      if (hasResourcesCapability(initializeResult)) {
        this.resourceServerNames.add(server.name)
        this.registerResourceTools(pi, client, server)
        resourceCount = await this.loadResourceSnapshot(client, server).catch(err => {
          const error = err instanceof Error ? err.message : String(err)
          this.options.emit?.('acp:mcp:error', { serverName: server.name, error })
          return 0
        })
      }
      this.clients.push(client)
      this.clientsByServer.set(server.name, client)
      this.recordStatus({
        name: server.name,
        state: 'connected',
        toolCount: tools.length,
        ...(resourceCount === undefined ? {} : { resourceCount })
      })
      this.options.emit?.('acp:mcp:connected', {
        serverName: server.name,
        toolCount: tools.length,
        ...(resourceCount === undefined ? {} : { resourceCount })
      })
    } catch (err) {
      await client.close().catch(() => undefined)
      const error = err instanceof Error ? err.message : String(err)
      this.recordStatus({ name: server.name, state: 'failed', toolCount: 0, error })
      this.options.emit?.('acp:mcp:error', { serverName: server.name, error })
    }
  }

  private refreshTools(pi: ExtensionAPI, client: McpStdioClient, server: StdioMcpServerConfig): Promise<void> {
    const existing = this.refreshTasks.get(server.name)
    if (existing) return existing

    const task = client
      .listTools()
      .then(tools => {
        this.disableRemovedTools(
          pi,
          server,
          new Set(tools.map(tool => tool.name).filter((name): name is string => typeof name === 'string' && !!name))
        )
        for (const tool of tools) this.registerTool(pi, client, server, tool)
        const toolCount = this.registeredTools.filter(tool => tool.serverName === server.name).length
        this.recordStatus({ name: server.name, state: 'connected', toolCount })
        this.options.emit?.('acp:mcp:tools_changed', { serverName: server.name, toolCount })
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err)
        this.options.emit?.('acp:mcp:error', { serverName: server.name, error })
      })
      .finally(() => {
        this.refreshTasks.delete(server.name)
      })

    this.refreshTasks.set(server.name, task)
    return task
  }

  private refreshResources(client: McpStdioClient, server: StdioMcpServerConfig): Promise<void> {
    const existing = this.resourceRefreshTasks.get(server.name)
    if (existing) return existing

    const task = this.loadResourceSnapshot(client, server)
      .then(resourceCount => {
        this.options.emit?.('acp:mcp:resources_changed', { serverName: server.name, resourceCount })
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err)
        this.options.emit?.('acp:mcp:error', { serverName: server.name, error })
      })
      .finally(() => {
        this.resourceRefreshTasks.delete(server.name)
      })

    this.resourceRefreshTasks.set(server.name, task)
    return task
  }

  private async loadResourceSnapshot(client: McpStdioClient, server: StdioMcpServerConfig): Promise<number> {
    const resources = await client.listResources()
    this.resourcesByServer.set(server.name, resources)
    this.updateStatusResourceCount(server.name, resources.length)
    return resources.length
  }

  private updateStatusResourceCount(serverName: string, resourceCount: number): void {
    const existing = this.statuses.find(item => item.name === serverName)
    if (existing) existing.resourceCount = resourceCount
  }

  private disableRemovedTools(pi: ExtensionAPI, server: StdioMcpServerConfig, activeMcpToolNames: Set<string>): void {
    for (let index = this.registeredTools.length - 1; index >= 0; index -= 1) {
      const registered = this.registeredTools[index]
      if (registered.serverName !== server.name || activeMcpToolNames.has(registered.mcpToolName)) continue

      this.registeredTools.splice(index, 1)
      pi.registerTool?.({
        name: registered.piToolName,
        label: `${server.name}: ${registered.mcpToolName} (removed)`,
        description: `MCP tool ${registered.mcpToolName} from ${server.name} is no longer advertised by the server.`,
        promptSnippet: `Unavailable MCP tool ${registered.mcpToolName} from ${server.name}.`,
        promptGuidelines: [`Do not use ${registered.piToolName}; the MCP server no longer advertises it.`],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'sequential',
        execute: async () => {
          throw new Error(`MCP tool ${server.name}/${registered.mcpToolName} is no longer advertised`)
        }
      })
      deactivateTool(pi, registered.piToolName)
      this.options.emit?.('acp:mcp:tool_removed', registered)
    }
  }

  private registerTool(pi: ExtensionAPI, client: McpStdioClient, server: StdioMcpServerConfig, tool: McpTool): void {
    if (!pi.registerTool || typeof tool.name !== 'string' || !tool.name.trim()) return
    if (
      this.registeredTools.some(existing => existing.serverName === server.name && existing.mcpToolName === tool.name)
    ) {
      return
    }

    const toolKey = mcpToolKey(server.name, tool.name)
    const piToolName =
      this.piToolNamesByMcpTool.get(toolKey) ?? uniqueToolName(this.toolNames, `mcp_${server.name}_${tool.name}`)
    this.piToolNamesByMcpTool.set(toolKey, piToolName)
    const description = tool.description?.trim() || `MCP tool ${tool.name} from ${server.name}`
    const parameters = normalizeInputSchema(tool.inputSchema)
    const registered = { serverName: server.name, mcpToolName: tool.name, piToolName }

    pi.registerTool({
      name: piToolName,
      label: `${server.name}: ${tool.name}`,
      description,
      promptSnippet: description,
      promptGuidelines: [`Use ${piToolName} for the ${tool.name} MCP tool from ${server.name}.`],
      parameters,
      executionMode: tool.annotations?.readOnlyHint === true ? 'parallel' : 'sequential',
      execute: async (_toolCallId, params, signal, onUpdate) => {
        if (signal?.aborted) throw new Error('MCP tool call cancelled')
        onUpdate?.({
          content: [{ type: 'text', text: `Calling MCP tool ${server.name}/${tool.name}...` }],
          details: registered
        })

        const result = await client.callTool(tool.name, params, signal)
        const content = mcpContentToPiContent(result)
        if (result.isError) throw new Error(contentToText(content) || `MCP tool ${tool.name} failed`)

        return {
          content,
          details: {
            ...registered,
            structuredContent: result.structuredContent ?? null
          }
        }
      }
    })

    this.registeredTools.push(registered)
  }

  private registerResourceTools(pi: ExtensionAPI, client: McpStdioClient, server: StdioMcpServerConfig): void {
    if (!pi.registerTool || this.registeredResourceTools.some(existing => existing.serverName === server.name)) return

    const listToolName = uniqueToolName(this.toolNames, `mcp_${server.name}_list_resources`)
    const readToolName = uniqueToolName(this.toolNames, `mcp_${server.name}_read_resource`)
    const registered = { serverName: server.name, listToolName, readToolName }

    pi.registerTool({
      name: listToolName,
      label: `${server.name}: list resources`,
      description: `List resources advertised by the ${server.name} MCP server.`,
      promptSnippet: `List resources advertised by the ${server.name} MCP server.`,
      promptGuidelines: [`Use ${listToolName} to inspect resources available from the ${server.name} MCP server.`],
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      executionMode: 'parallel',
      execute: async () => {
        const resources = await client.listResources()
        this.resourcesByServer.set(server.name, resources)
        this.updateStatusResourceCount(server.name, resources.length)
        return {
          content: resourcesToPiContent(server.name, resources),
          details: {
            ...registered,
            resourceCount: resources.length,
            resources
          }
        }
      }
    })

    pi.registerTool({
      name: readToolName,
      label: `${server.name}: read resource`,
      description: `Read a resource from the ${server.name} MCP server by URI.`,
      promptSnippet: `Read a resource from the ${server.name} MCP server by URI.`,
      promptGuidelines: [`Use ${readToolName} with a resource URI returned by ${listToolName}.`],
      parameters: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'The MCP resource URI to read.'
          }
        },
        required: ['uri'],
        additionalProperties: false
      },
      executionMode: 'parallel',
      execute: async (_toolCallId, params, signal) => {
        const uri = typeof params.uri === 'string' ? params.uri : ''
        if (!uri) throw new Error('MCP resource uri is required')
        const result = await client.readResource(uri, signal)
        return {
          content: mcpResourceContentsToPiContent(result),
          details: {
            ...registered,
            uri,
            contents: result.contents.map(content => ({
              uri: content.uri,
              mimeType: content.mimeType ?? null,
              type: content.text !== undefined ? 'text' : 'blob'
            }))
          }
        }
      }
    })

    this.registeredResourceTools.push(registered)
  }

  private recordStatus(status: McpServerStatus): void {
    const existing = this.statuses.findIndex(item => item.name === status.name)
    if (existing >= 0) this.statuses[existing] = status
    else this.statuses.push(status)
  }
}

function deactivateTool(pi: ExtensionAPI, toolName: string): void {
  if (!pi.getActiveTools || !pi.setActiveTools) return

  try {
    const activeTools = pi.getActiveTools()
    if (!Array.isArray(activeTools) || !activeTools.includes(toolName)) return
    pi.setActiveTools(activeTools.filter(name => name !== toolName))
  } catch {
    // Keep the disabled replacement tool as the fallback when active-tool updates fail.
  }
}

function mcpToolKey(serverName: string, toolName: string): string {
  return `${serverName}\u0000${toolName}`
}

export function normalizeStdioMcpServers(setup: BridgeSetupForMcp): {
  stdio: StdioMcpServerConfig[]
  unsupported: Array<{ name: string; transport: string }>
} {
  const stdio: StdioMcpServerConfig[] = []
  const unsupported: Array<{ name: string; transport: string }> = []

  for (const raw of Array.isArray(setup.mcpServers) ? setup.mcpServers : []) {
    if (!raw || typeof raw !== 'object') continue
    const server = raw as Record<string, unknown>
    const transport = typeof server.type === 'string' ? server.type : 'stdio'
    const name = typeof server.name === 'string' && server.name.trim() ? server.name.trim() : 'mcp'

    if (transport !== 'stdio') {
      unsupported.push({ name, transport })
      continue
    }

    const command = typeof server.command === 'string' ? server.command : ''
    if (!command) continue

    stdio.push({
      name,
      command,
      args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: normalizeEnv(server.env),
      cwd: typeof setup.cwd === 'string' && setup.cwd ? setup.cwd : undefined
    })
  }

  return { stdio, unsupported }
}

export function connectMcpStdioServers(
  setup: BridgeSetupForMcp,
  pi: ExtensionAPI,
  options: ConnectOptions = {}
): Promise<McpBridgeRuntime> {
  const runtime = new McpBridgeRuntime(setup, options)
  return runtime.connect(pi).then(() => runtime)
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer: Buffer | undefined
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()

  constructor(
    private readonly server: StdioMcpServerConfig,
    private readonly options: { timeoutMs?: number; onNotification?: (notification: unknown) => void } = {}
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error(`MCP server already started: ${this.server.name}`)

    const child = spawn(this.server.command, this.server.args, {
      cwd: this.server.cwd,
      env: { ...defaultMcpEnvironment(), ...this.server.env },
      stdio: 'pipe',
      shell: false,
      windowsHide: true
    })

    child.stdout.on('data', chunk => this.onStdout(chunk))
    child.stderr.resume()
    child.on('close', code => {
      this.rejectAll(new Error(`MCP server exited: ${this.server.name} (code=${code})`))
      this.child = null
    })
    child.on('error', err => this.rejectAll(err))

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup()
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    this.child = child
  }

  async initialize(): Promise<McpInitializeResult> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'pi-acp',
        version: '0.0.27'
      }
    })
    await this.notify('notifications/initialized')
    return normalizeInitializeResult(result)
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined

    do {
      const result = await this.request('tools/list', cursor ? { cursor } : undefined)
      const page = result && typeof result === 'object' ? (result as { tools?: unknown; nextCursor?: unknown }) : {}
      if (Array.isArray(page.tools)) {
        for (const tool of page.tools) {
          if (isMcpTool(tool)) tools.push(tool)
        }
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor)

    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, signal)
    return normalizeCallToolResult(result)
  }

  async listResources(): Promise<McpResource[]> {
    const resources: McpResource[] = []
    let cursor: string | undefined

    do {
      const result = await this.request('resources/list', cursor ? { cursor } : undefined)
      const page = result && typeof result === 'object' ? (result as { resources?: unknown; nextCursor?: unknown }) : {}
      if (Array.isArray(page.resources)) {
        for (const resource of page.resources) {
          const normalized = normalizeMcpResource(resource)
          if (normalized) resources.push(normalized)
        }
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor)

    return resources
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const result = await this.request('resources/read', { uri }, signal)
    return normalizeReadResourceResult(result)
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.rejectAll(new Error(`MCP server closed: ${this.server.name}`))
    if (!child) return

    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000)
      timer.unref?.()
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })

    if (child.exitCode === null) child.kill('SIGTERM')
  }

  private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.child) throw new Error(`MCP server is not connected: ${this.server.name}`)
    if (signal?.aborted) return Promise.reject(new Error('MCP request cancelled'))

    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${this.server.name}/${method}`))
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      timer.unref?.()

      const abort = signal
        ? () => {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(new Error('MCP request cancelled'))
          }
        : undefined

      if (signal && abort) signal.addEventListener('abort', abort, { once: true })

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        abort: abort
          ? () => {
              signal?.removeEventListener('abort', abort)
            }
          : undefined
      })

      this.write(message).catch(err => {
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pending.abort?.()
        } else {
          clearTimeout(timer)
        }
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private async write(message: unknown): Promise<void> {
    if (!this.child?.stdin) throw new Error(`MCP server is not connected: ${this.server.name}`)
    const line = JSON.stringify(message) + '\n'
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        this.child?.stdin.off('error', onError)
      }
      this.child?.stdin.once('error', onError)
      if (this.child?.stdin.write(line)) {
        cleanup()
        resolve()
      } else {
        this.child?.stdin.once('drain', () => {
          cleanup()
          resolve()
        })
      }
    })
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk

    while (this.buffer) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return

      const line = this.buffer.toString('utf8', 0, index).replace(/\r$/, '')
      this.buffer = this.buffer.subarray(index + 1)
      if (!line.trim()) continue

      try {
        this.handleMessage(JSON.parse(line))
      } catch (err) {
        this.options.onNotification?.({
          method: 'acp/mcp_parse_error',
          params: { serverName: this.server.name, error: err instanceof Error ? err.message : String(err) }
        })
      }
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const msg = message as Partial<JsonRpcResponse> & { method?: unknown; params?: unknown }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      pending.abort?.()

      if (msg.error) {
        pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`))
        return
      }

      pending.resolve(msg.result)
      return
    }

    if (typeof msg.method === 'string') {
      this.options.onNotification?.({ method: msg.method, params: msg.params })
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.abort?.()
      pending.reject(err)
    }
  }
}

function isMcpTool(value: unknown): value is McpTool {
  return Boolean(value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string')
}

function hasToolsCapability(result: McpInitializeResult): boolean {
  return Boolean(result.capabilities && typeof result.capabilities === 'object' && result.capabilities.tools)
}

function hasResourcesCapability(result: McpInitializeResult): boolean {
  return Boolean(result.capabilities && typeof result.capabilities === 'object' && result.capabilities.resources)
}

function isToolsListChangedNotification(notification: unknown): boolean {
  return (
    Boolean(notification && typeof notification === 'object') &&
    (notification as { method?: unknown }).method === 'notifications/tools/list_changed'
  )
}

function isResourcesListChangedNotification(notification: unknown): boolean {
  return (
    Boolean(notification && typeof notification === 'object') &&
    (notification as { method?: unknown }).method === 'notifications/resources/list_changed'
  )
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema))
    return cloneJson(schema as Record<string, unknown>)
  return { type: 'object', properties: {}, additionalProperties: true }
}

function normalizeInitializeResult(result: unknown): McpInitializeResult {
  if (!result || typeof result !== 'object') return {}
  const capabilities = (result as { capabilities?: unknown }).capabilities
  return capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? { capabilities: capabilities as McpInitializeResult['capabilities'] }
    : {}
}

function normalizeMcpResource(value: unknown): McpResource | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.uri !== 'string' || !raw.uri) return null
  if (typeof raw.name !== 'string' || !raw.name) return null

  return {
    uri: raw.uri,
    name: raw.name,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
    ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    ...(typeof raw.size === 'number' && Number.isFinite(raw.size) ? { size: raw.size } : {})
  }
}

function normalizeReadResourceResult(result: unknown): McpReadResourceResult {
  if (!result || typeof result !== 'object') return { contents: [] }
  const rawContents = (result as { contents?: unknown }).contents
  const contents = Array.isArray(rawContents)
    ? rawContents.map(normalizeMcpResourceContent).filter((content): content is McpResourceContent => Boolean(content))
    : []
  return { contents }
}

function normalizeMcpResourceContent(value: unknown): McpResourceContent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.uri !== 'string' || !raw.uri) return null

  return {
    uri: raw.uri,
    ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(typeof raw.blob === 'string' ? { blob: raw.blob } : {})
  }
}

function normalizeCallToolResult(result: unknown): McpCallToolResult {
  if (!result || typeof result !== 'object') return { content: [{ type: 'text', text: String(result ?? '') }] }
  const raw = result as McpCallToolResult
  return {
    content: Array.isArray(raw.content) ? raw.content : [],
    structuredContent:
      raw.structuredContent && typeof raw.structuredContent === 'object' && !Array.isArray(raw.structuredContent)
        ? raw.structuredContent
        : undefined,
    isError: raw.isError === true
  }
}

function mcpContentToPiContent(result: McpCallToolResult): PiToolContent[] {
  const content: PiToolContent[] = []

  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!block || typeof block !== 'object') continue
    const typed = block as Record<string, unknown>

    if (typed.type === 'text' && typeof typed.text === 'string') {
      content.push({ type: 'text', text: typed.text })
      continue
    }

    if (typed.type === 'image' && typeof typed.data === 'string' && typeof typed.mimeType === 'string') {
      content.push({ type: 'image', data: typed.data, mimeType: typed.mimeType })
      continue
    }

    content.push({ type: 'text', text: summarizeMcpContentBlock(typed) })
  }

  if (result.structuredContent && Object.keys(result.structuredContent).length) {
    content.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) })
  }

  return content.length ? content : [{ type: 'text', text: '(no MCP tool output)' }]
}

function resourcesToPiContent(serverName: string, resources: McpResource[]): PiToolContent[] {
  if (!resources.length) return [{ type: 'text', text: `MCP server ${serverName} has no listed resources.` }]

  return [
    {
      type: 'text',
      text: resources
        .map(resource => {
          const label = resource.title ?? resource.name
          const details = [
            resource.description ? `description: ${resource.description}` : null,
            resource.mimeType ? `mimeType: ${resource.mimeType}` : null,
            resource.size !== undefined ? `size: ${resource.size}` : null
          ].filter((line): line is string => Boolean(line))
          return [`- ${label} <${resource.uri}>`, ...details.map(line => `  ${line}`)].join('\n')
        })
        .join('\n')
    }
  ]
}

function mcpResourceContentsToPiContent(result: McpReadResourceResult): PiToolContent[] {
  const content: PiToolContent[] = []

  for (const item of result.contents) {
    if (typeof item.text === 'string') {
      const header = `[MCP resource: ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ''}]`
      content.push({ type: 'text', text: `${header}\n${item.text}` })
      continue
    }

    if (typeof item.blob === 'string') {
      if (item.mimeType?.startsWith('image/')) {
        content.push({ type: 'image', data: item.blob, mimeType: item.mimeType })
        continue
      }

      const byteLength = Buffer.byteLength(item.blob, 'base64')
      content.push({
        type: 'text',
        text: `[MCP resource: ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ''}, ${byteLength} bytes]`
      })
    }
  }

  return content.length ? content : [{ type: 'text', text: '(no MCP resource content)' }]
}

function summarizeMcpContentBlock(block: Record<string, unknown>): string {
  if (block.type === 'audio') return `[MCP audio: ${String(block.mimeType ?? 'unknown mime type')}]`
  if (block.type === 'resource_link') return summarizeMcpResourceLink(block)
  if (block.type === 'resource') return summarizeMcpEmbeddedResource(block.resource)
  return JSON.stringify(block)
}

function summarizeMcpResourceLink(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' && block.name ? block.name : 'resource'
  const uri = typeof block.uri === 'string' && block.uri ? block.uri : null
  const title = typeof block.title === 'string' && block.title ? block.title : null
  const description = typeof block.description === 'string' && block.description ? block.description : null
  const mimeType = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : null
  const size = typeof block.size === 'number' && Number.isFinite(block.size) ? block.size : null

  const header = `[MCP resource link: ${title ?? name}${uri ? ` <${uri}>` : ''}]`
  const details = [
    description ? `description: ${description}` : null,
    mimeType ? `mimeType: ${mimeType}` : null,
    size !== null ? `size: ${size}` : null
  ].filter((line): line is string => Boolean(line))

  return details.length ? `${header}\n${details.join('\n')}` : header
}

function summarizeMcpEmbeddedResource(resource: unknown): string {
  if (!resource || typeof resource !== 'object') return '[MCP resource content]'

  const typed = resource as Record<string, unknown>
  const uri = typeof typed.uri === 'string' && typed.uri ? typed.uri : 'unknown-uri'
  const mimeType = typeof typed.mimeType === 'string' && typed.mimeType ? typed.mimeType : null

  if (typeof typed.text === 'string') {
    const header = `[MCP resource: ${uri}${mimeType ? ` (${mimeType})` : ''}]`
    return `${header}\n${typed.text}`
  }

  if (typeof typed.blob === 'string') {
    const byteLength = Buffer.byteLength(typed.blob, 'base64')
    return `[MCP resource: ${uri}${mimeType ? ` (${mimeType})` : ''}, ${byteLength} bytes]`
  }

  return `[MCP resource: ${uri}${mimeType ? ` (${mimeType})` : ''}]`
}

function contentToText(content: PiToolContent[]): string {
  return content
    .map(block => (block.type === 'text' ? block.text : `[image: ${block.mimeType}]`))
    .join('\n')
    .trim()
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const env: Record<string, string> = {}
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const name = (item as { name?: unknown }).name
      const envValue = (item as { value?: unknown }).value
      if (typeof name === 'string' && typeof envValue === 'string') env[name] = envValue
    }
    return env
  }

  if (value && typeof value === 'object') {
    const env: Record<string, string> = {}
    for (const [name, envValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof envValue === 'string') env[name] = envValue
    }
    return env
  }

  return {}
}

function defaultMcpEnvironment(): Record<string, string> {
  const names =
    process.platform === 'win32'
      ? [
          'APPDATA',
          'HOMEDRIVE',
          'HOMEPATH',
          'LOCALAPPDATA',
          'PATH',
          'PROCESSOR_ARCHITECTURE',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERNAME',
          'USERPROFILE',
          'PROGRAMFILES'
        ]
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']

  const env: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (value && !value.startsWith('()')) env[name] = value
  }
  return env
}

function uniqueToolName(used: Set<string>, raw: string): string {
  const base = sanitizeToolName(raw)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    const tail = `_${suffix++}`
    candidate = base.slice(0, Math.max(1, 64 - tail.length)) + tail
  }
  used.add(candidate)
  return candidate
}

function sanitizeToolName(raw: string): string {
  const sanitized = raw
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return sanitized || `mcp_${basename(raw) || 'tool'}`
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}
