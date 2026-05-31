import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import acpBridge, { type PiAcpBridgeService } from '../../src/pi-extension/acp-bridge.js'
import { ACP_BRIDGE_SETUP_ENV, type PiAcpBridgeSetup } from '../../src/pi-rpc/bridge-extension.js'
import { startBridgeRpcServer } from '../../src/pi-rpc/bridge-rpc.js'

class FakeEvents {
  readonly emitted: Array<{ channel: string; data: unknown }> = []
  private readonly handlers = new Map<string, Array<(data: unknown) => void>>()

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data })
    for (const handler of this.handlers.get(channel) ?? []) handler(data)
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const list = this.handlers.get(channel) ?? []
    list.push(handler)
    this.handlers.set(channel, list)
    return () => {
      this.handlers.set(
        channel,
        (this.handlers.get(channel) ?? []).filter(existing => existing !== handler)
      )
    }
  }
}

test('ACP bridge extension: exposes a reusable inter-extension service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-test-'))
  const setupPath = join(dir, 'setup.json')
  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: null,
    mcpServers: [{ type: 'http', name: 'http-test', url: 'https://mcp.test', headers: [] }],
    clientCapabilities: { fs: { readTextFile: true }, terminal: true },
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const commands = new Map<string, any>()
    const notifications: Array<{ message: string; type?: string }> = []
    await acpBridge({
      events,
      registerCommand: (name: string, command: any) => commands.set(name, command),
      getAllTools: () => [{ name: 'read' }, { name: 'mcp_http_test_echo' }]
    } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    assert.equal(ready.type, 'pi-acp-bridge')
    assert.equal(ready.version, 1)
    assert.deepEqual(ready.getMcpServers(), setup.mcpServers)
    assert.deepEqual(ready.getClientCapabilities(), setup.clientCapabilities)
    assert.deepEqual(ready.getMcpStatus(), [
      {
        name: 'http-test',
        state: 'unsupported',
        toolCount: 0,
        error: 'http MCP transport is not advertised or implemented by pi-acp'
      }
    ])
    assert.deepEqual(ready.getRegisteredMcpTools(), [])
    assert.deepEqual(ready.getRegisteredMcpResourceTools(), [])
    assert.deepEqual(ready.getMcpResources(), [])
    assert.deepEqual(await ready.listMcpResources(), [])
    await assert.rejects(
      () => ready.readMcpResource('http-test', 'memory://missing'),
      /not connected|does not advertise/
    )
    assert.deepEqual(await ready.getPromptResourceLinks(), [])
    await assert.rejects(() => ready.readPromptResource('file:///tmp/file.txt'), /adapter RPC is not available/)
    await assert.rejects(() => ready.readTextFile('/tmp/file.txt'), /did not advertise|not available/)
    assert.deepEqual(ready.getPublicSetup(), {
      version: 1,
      lifecycle: 'new',
      cwd: '/tmp/project',
      sessionId: null,
      mcpServerCount: 1,
      hasClientCapabilities: true,
      hasAdapterRpc: false,
      createdAt: '2026-05-30T00:00:00.000Z'
    })

    const request = { service: null as PiAcpBridgeService | null }
    events.emit('acp:bridge:request', { reply: (service: PiAcpBridgeService) => (request.service = service) })
    assert.ok(request.service)
    const requested = request.service
    assert.equal(requested.type, 'pi-acp-bridge')

    const exposed = requested.getMcpServers() as Array<{ name: string }>
    exposed[0].name = 'mutated'
    assert.equal((requested.getMcpServers() as Array<{ name: string }>)[0].name, 'http-test')

    const statusCommand = commands.get('acp-bridge-status')
    assert.ok(statusCommand)
    await statusCommand.handler('', {
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type })
      }
    })

    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].type, 'info')
    assert.match(notifications[0].message, /^ACP bridge status: /)
    const status = JSON.parse(notifications[0].message.replace(/^ACP bridge status: /, ''))
    assert.deepEqual(status.mcpStatus, ready.getMcpStatus())
    assert.deepEqual(status.registeredMcpTools, [])
    assert.deepEqual(status.registeredMcpResourceTools, [])
    assert.deepEqual(status.mcpResources, [])
    assert.deepEqual(status.piToolNames, ['read', 'mcp_http_test_echo'])
  } finally {
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: exposes prompt resource service methods and tool shims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-prompt-resource-test-'))
  const setupPath = join(dir, 'setup.json')
  const resource = {
    type: 'resource_link',
    uri: 'file:///tmp/prompt-resource.txt',
    name: 'prompt-resource.txt',
    title: 'Prompt resource',
    mimeType: 'text/plain',
    size: 19
  }
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'resource/list_prompt_resource_links') return { resources: [resource] }
    if (method === 'resource/read_prompt_resource') {
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: 'text/plain',
            text: 'from prompt resource\n'
          }
        ]
      }
    }
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: 'sess-prompt-resource',
    mcpServers: [],
    clientCapabilities: null,
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const tools = new Map<string, any>()
    const commands = new Map<string, any>()
    const notifications: Array<{ message: string; type?: string }> = []
    await acpBridge({
      events,
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command)
    } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    assert.equal(ready.getPublicSetup().hasAdapterRpc, true)
    assert.deepEqual([...tools.keys()], ['acp_list_prompt_resources', 'acp_read_prompt_resource'])

    assert.deepEqual(await ready.getPromptResourceLinks(), [resource])
    assert.deepEqual(await ready.readPromptResource(resource.uri), {
      contents: [{ uri: resource.uri, mimeType: 'text/plain', text: 'from prompt resource\n' }]
    })

    const listResult = await tools.get('acp_list_prompt_resources').execute('list-prompt-resources', {})
    assert.deepEqual(listResult.content, [{ type: 'text', text: JSON.stringify([resource], null, 2) }])
    assert.deepEqual(listResult.details, { source: 'acp-prompt-resources', count: 1 })

    const readResult = await tools.get('acp_read_prompt_resource').execute('read-prompt-resource', {
      uri: resource.uri
    })
    assert.deepEqual(readResult.content, [{ type: 'text', text: 'from prompt resource\n' }])
    assert.deepEqual(readResult.details, {
      source: 'acp-prompt-resources',
      uri: resource.uri,
      contents: [{ uri: resource.uri, mimeType: 'text/plain', text: 'from prompt resource\n' }]
    })

    const readCommand = commands.get('acp-read-prompt-resource')
    assert.ok(readCommand)
    await readCommand.handler(resource.uri, {
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type })
      }
    })
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].type, 'info')
    assert.match(notifications[0].message, /^ACP prompt resource: /)

    assert.deepEqual(calls, [
      { method: 'resource/list_prompt_resource_links', params: {} },
      { method: 'resource/read_prompt_resource', params: { uri: resource.uri } },
      { method: 'resource/list_prompt_resource_links', params: {} },
      { method: 'resource/read_prompt_resource', params: { uri: resource.uri } },
      { method: 'resource/read_prompt_resource', params: { uri: resource.uri } }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: blocks configured tool calls through ACP permission bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-tool-permission-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'permission/request_tool_call') {
      return { allowed: false, reason: 'Denied by test client', optionId: 'reject' }
    }
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: null,
    mcpServers: [],
    clientCapabilities: null,
    toolCallPermissions: {
      enabled: true,
      toolNames: ['bash']
    },
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>()
    await acpBridge({
      events,
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => {
        hooks.set(event, handler)
      }
    } as any)

    const toolCall = hooks.get('tool_call')
    assert.ok(toolCall)

    assert.deepEqual(
      await toolCall(
        { type: 'tool_call', toolCallId: 'bash-1', toolName: 'bash', input: { command: 'rm -rf tmp' } },
        {}
      ),
      { block: true, reason: 'Denied by test client' }
    )
    assert.equal(
      await toolCall({ type: 'tool_call', toolCallId: 'read-1', toolName: 'read', input: { path: 'README.md' } }, {}),
      undefined
    )
    assert.deepEqual(calls, [
      {
        method: 'permission/request_tool_call',
        params: {
          toolCallId: 'bash-1',
          toolName: 'bash',
          input: { command: 'rm -rf tmp' }
        }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: exposes a reusable ACP plan publishing service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-plan-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'plan/update') return {}
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: null,
    mcpServers: [],
    clientCapabilities: null,
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    await acpBridge({ events } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    await ready.publishPlan([
      { content: 'Inspect current behavior', priority: 'high', status: 'completed' },
      { content: 'Publish ACP plan', priority: 'medium', status: 'in_progress', _meta: { source: 'test' } }
    ])

    assert.deepEqual(calls, [
      {
        method: 'plan/update',
        params: {
          entries: [
            { content: 'Inspect current behavior', priority: 'high', status: 'completed' },
            { content: 'Publish ACP plan', priority: 'medium', status: 'in_progress', _meta: { source: 'test' } }
          ]
        }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: exposes a reusable prompt stop-reason service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-stop-reason-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'prompt/set_stop_reason') return {}
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: null,
    mcpServers: [],
    clientCapabilities: null,
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    await acpBridge({ events } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    await ready.setPromptStopReason('max_turn_requests', { source: 'test-extension' })

    assert.deepEqual(calls, [
      {
        method: 'prompt/set_stop_reason',
        params: {
          stopReason: 'max_turn_requests',
          source: 'test-extension'
        }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: restores refused prompt history through command-context tree navigation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-refusal-history-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'prompt/refusal_history_restore_result') return {}
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: 'sess-refusal',
    mcpServers: [],
    clientCapabilities: null,
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>()
    const commands = new Map<string, any>()
    await acpBridge({
      events,
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) =>
        hooks.set(event, handler),
      registerCommand: (name: string, command: any) => commands.set(name, command)
    } as any)

    const beforeAgentStart = hooks.get('before_agent_start')
    const agentEnd = hooks.get('agent_end')
    const restoreCommand = commands.get('acp-restore-refusal-history')
    assert.ok(beforeAgentStart)
    assert.ok(agentEnd)
    assert.ok(restoreCommand)

    const entries = [
      { id: 'assistant-1', parentId: null, type: 'message', message: { role: 'assistant' } },
      { id: 'user-2', parentId: 'assistant-1', type: 'message', message: { role: 'user' } },
      { id: 'assistant-3', parentId: 'user-2', type: 'message', message: { role: 'assistant' } }
    ]
    const sessionManager = {
      getSessionId: () => 'sess-refusal',
      getLeafId: () => 'assistant-1',
      getEntries: () => entries
    }
    const navigations: Array<{ targetId: string; options: unknown }> = []
    const ctx = {
      sessionManager,
      navigateTree: async (targetId: string, options: unknown) => {
        navigations.push({ targetId, options })
        return { cancelled: false }
      }
    }

    await beforeAgentStart({ type: 'before_agent_start' }, ctx)
    await agentEnd({ type: 'agent_end' }, ctx)
    await restoreCommand.handler('', ctx)

    assert.deepEqual(navigations, [{ targetId: 'user-2', options: { summarize: false } }])
    assert.deepEqual(calls, [
      {
        method: 'prompt/refusal_history_restore_result',
        params: {
          restored: true,
          source: 'pi-acp-bridge',
          sessionId: 'sess-refusal',
          safeLeafId: 'assistant-1',
          userEntryId: 'user-2'
        }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: exposes client fs service methods and tool shims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-fs-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const files = new Map<string, string>([
    ['/tmp/client.txt', 'from client fs\nsecond line'],
    ['/tmp/project/relative.txt', 'line one\nline two'],
    ['/tmp/project/edit.txt', 'alpha\nbeta\ngamma\n']
  ])
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'fs/read_text_file') {
      const request = params as { path?: unknown; line?: unknown; limit?: unknown }
      if (typeof request.path !== 'string') throw new Error('missing path')
      const content = files.get(request.path)
      if (content === undefined) throw new Error(`missing file ${request.path}`)
      return { content: sliceLines(content, request.line, request.limit) }
    }
    if (method === 'fs/write_text_file') {
      const request = params as { path?: unknown; content?: unknown }
      if (typeof request.path !== 'string') throw new Error('missing path')
      if (typeof request.content !== 'string') throw new Error('missing content')
      files.set(request.path, request.content)
      return {}
    }
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: 'sess-fs',
    mcpServers: [],
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const tools = new Map<string, any>()
    await acpBridge({
      events,
      registerTool: (tool: any) => tools.set(tool.name, tool)
    } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    assert.equal(ready.getPublicSetup().hasAdapterRpc, true)

    assert.deepEqual(
      [...tools.keys()],
      [
        'acp_list_prompt_resources',
        'acp_read_prompt_resource',
        'acp_read_text_file',
        'read',
        'acp_write_text_file',
        'write',
        'edit'
      ]
    )
    assert.equal(await ready.readTextFile('/tmp/client.txt', { line: 1, limit: 5 }), 'from client fs\nsecond line')
    await ready.writeTextFile('/tmp/client.txt', 'updated')

    const readResult = await tools.get('acp_read_text_file').execute('read-1', {
      path: '/tmp/client.txt',
      line: 1,
      limit: 1
    })
    assert.deepEqual(readResult.content, [{ type: 'text', text: 'updated' }])
    assert.deepEqual(readResult.details, {
      path: '/tmp/client.txt',
      line: 1,
      limit: 1,
      source: 'acp-client-fs'
    })

    const writeResult = await tools.get('acp_write_text_file').execute('write-1', {
      path: '/tmp/client.txt',
      content: 'tool write'
    })
    assert.match(writeResult.content[0].text, /Wrote 10 bytes/)

    const shadowRead = await tools.get('read').execute('read-shadow', {
      path: 'relative.txt',
      offset: 2,
      limit: 1
    })
    assert.deepEqual(shadowRead.content, [{ type: 'text', text: 'line two' }])
    assert.deepEqual(shadowRead.details, {
      path: '/tmp/project/relative.txt',
      offset: 2,
      limit: 1,
      source: 'acp-client-fs',
      tool: 'read'
    })

    const shadowWrite = await tools.get('write').execute('write-shadow', {
      path: 'new.txt',
      content: 'shadow write'
    })
    assert.deepEqual(files.get('/tmp/project/new.txt'), 'shadow write')
    assert.deepEqual(shadowWrite.details, {
      path: '/tmp/project/new.txt',
      bytes: 12,
      oldText: null,
      newText: 'shadow write',
      source: 'acp-client-fs',
      tool: 'write'
    })

    const shadowEdit = await tools.get('edit').execute('edit-shadow', {
      path: 'edit.txt',
      edits: [{ oldText: 'beta', newText: 'BETA' }]
    })
    assert.deepEqual(files.get('/tmp/project/edit.txt'), 'alpha\nBETA\ngamma\n')
    assert.deepEqual(shadowEdit.details, {
      path: '/tmp/project/edit.txt',
      oldText: 'alpha\nbeta\ngamma\n',
      newText: 'alpha\nBETA\ngamma\n',
      source: 'acp-client-fs',
      tool: 'edit'
    })

    const prepared = tools.get('edit').prepareArguments({ path: 'edit.txt', oldText: 'BETA', newText: 'beta' })
    assert.deepEqual(prepared, { path: 'edit.txt', edits: [{ oldText: 'BETA', newText: 'beta' }] })

    assert.deepEqual(calls.slice(0, 4), [
      { method: 'fs/read_text_file', params: { path: '/tmp/client.txt', line: 1, limit: 5 } },
      { method: 'fs/write_text_file', params: { path: '/tmp/client.txt', content: 'updated' } },
      { method: 'fs/read_text_file', params: { path: '/tmp/client.txt', line: 1, limit: 1 } },
      { method: 'fs/write_text_file', params: { path: '/tmp/client.txt', content: 'tool write' } }
    ])
    assert.deepEqual(calls.slice(4), [
      { method: 'fs/read_text_file', params: { path: '/tmp/project/relative.txt', line: 2, limit: 1 } },
      { method: 'fs/read_text_file', params: { path: '/tmp/project/new.txt' } },
      { method: 'fs/write_text_file', params: { path: '/tmp/project/new.txt', content: 'shadow write' } },
      { method: 'fs/read_text_file', params: { path: '/tmp/project/edit.txt' } },
      {
        method: 'fs/write_text_file',
        params: { path: '/tmp/project/edit.txt', content: 'alpha\nBETA\ngamma\n' }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

function sliceLines(content: string, line: unknown, limit: unknown): string {
  if (typeof line !== 'number' && typeof limit !== 'number') return content
  const lines = content.split('\n')
  const start = typeof line === 'number' ? Math.max(0, line - 1) : 0
  const end = typeof limit === 'number' ? start + limit : undefined
  return lines.slice(start, end).join('\n')
}

test('ACP bridge extension: exposes client terminal service methods and tool shim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-terminal-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc = await startBridgeRpcServer((method, params) => {
    calls.push({ method, params })
    if (method === 'terminal/create') return { terminalId: 'term-client-1' }
    if (method === 'terminal/wait_for_exit') return { exitCode: 0, signal: null }
    if (method === 'terminal/output') {
      return {
        output: 'terminal done\n',
        truncated: false,
        exitStatus: { exitCode: 0, signal: null }
      }
    }
    if (method === 'terminal/kill') return {}
    if (method === 'terminal/release') return {}
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: 'sess-terminal',
    mcpServers: [],
    clientCapabilities: { terminal: true },
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const tools = new Map<string, any>()
    await acpBridge({
      events,
      registerTool: (tool: any) => tools.set(tool.name, tool)
    } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService
    assert.equal(ready.getPublicSetup().hasAdapterRpc, true)
    assert.deepEqual(
      [...tools.keys()],
      ['acp_list_prompt_resources', 'acp_read_prompt_resource', 'acp_terminal_execute', 'bash']
    )

    assert.deepEqual(await ready.createTerminal({ command: 'pwd', cwd: '/tmp/project' }), {
      terminalId: 'term-client-1'
    })
    assert.deepEqual(await ready.terminalWaitForExit('term-client-1'), { exitCode: 0, signal: null })
    assert.deepEqual(await ready.terminalOutput('term-client-1'), {
      output: 'terminal done\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null }
    })
    await ready.terminalKill('term-client-1')
    await ready.terminalRelease('term-client-1')

    assert.deepEqual(await ready.executeTerminalCommand({ command: 'node', args: ['--version'] }), {
      terminalId: 'term-client-1',
      output: 'terminal done\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null }
    })

    const toolResult = await tools.get('acp_terminal_execute').execute('terminal-1', {
      command: 'npm',
      args: ['test'],
      cwd: '/tmp/project',
      env: { NODE_ENV: 'test' },
      outputByteLimit: 2048
    })
    assert.deepEqual(toolResult.content, [{ type: 'text', text: 'terminal done\n' }])
    assert.deepEqual(toolResult.details, {
      terminalId: 'term-client-1',
      command: 'npm',
      args: ['test'],
      cwd: '/tmp/project',
      outputByteLimit: 2048,
      output: 'terminal done\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
      terminalRelease: 'pi-acp-after-tool-call-update',
      source: 'acp-client-terminal'
    })

    const bashResult = await tools.get('bash').execute('bash-1', {
      command: 'echo terminal',
      timeout: 5
    })
    assert.deepEqual(bashResult.content, [{ type: 'text', text: 'terminal done\n' }])
    const expectedShell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || 'bash'
    const expectedShellArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', 'echo terminal'] : ['-lc', 'echo terminal']
    assert.deepEqual(bashResult.details, {
      terminalId: 'term-client-1',
      command: 'echo terminal',
      shellCommand: expectedShell,
      shellArgs: expectedShellArgs,
      cwd: '/tmp/project',
      timeout: 5,
      output: 'terminal done\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
      terminalRelease: 'pi-acp-after-tool-call-update',
      source: 'acp-client-terminal',
      tool: 'bash'
    })

    assert.deepEqual(calls, [
      { method: 'terminal/create', params: { command: 'pwd', cwd: '/tmp/project' } },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/output', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/kill', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/release', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/create', params: { command: 'node', args: ['--version'] } },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/output', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/release', params: { terminalId: 'term-client-1' } },
      {
        method: 'terminal/create',
        params: {
          command: 'npm',
          args: ['test'],
          env: [{ name: 'NODE_ENV', value: 'test' }],
          cwd: '/tmp/project',
          outputByteLimit: 2048
        }
      },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/output', params: { terminalId: 'term-client-1' } },
      {
        method: 'terminal/create',
        params: {
          command: expectedShell,
          args: expectedShellArgs,
          cwd: '/tmp/project'
        }
      },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-client-1' } },
      { method: 'terminal/output', params: { terminalId: 'term-client-1' } }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ACP bridge extension: kills client terminal on timeout and abort interruptions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-terminal-interrupt-test-'))
  const setupPath = join(dir, 'setup.json')
  const calls: Array<{ method: string; params: unknown }> = []
  let terminalIndex = 0
  let pendingExit = deferred<void>()
  const rpc = await startBridgeRpcServer(async (method, params) => {
    calls.push({ method, params })
    if (method === 'terminal/create') {
      terminalIndex += 1
      pendingExit = deferred<void>()
      return { terminalId: `term-interrupt-${terminalIndex}` }
    }
    if (method === 'terminal/wait_for_exit') {
      await pendingExit.promise
      return { exitCode: null, signal: 'killed' }
    }
    if (method === 'terminal/kill') {
      pendingExit.resolve()
      return {}
    }
    if (method === 'terminal/output') {
      return { output: `interrupted ${terminalIndex}\n`, truncated: false }
    }
    if (method === 'terminal/release') return {}
    throw new Error(`unexpected method ${method}`)
  })

  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/tmp/project',
    sessionId: 'sess-terminal-interrupt',
    mcpServers: [],
    clientCapabilities: { terminal: true },
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const events = new FakeEvents()
    const tools = new Map<string, any>()
    await acpBridge({
      events,
      registerTool: (tool: any) => tools.set(tool.name, tool)
    } as any)

    const ready = events.emitted.find(event => event.channel === 'acp:bridge:ready')?.data as PiAcpBridgeService

    assert.deepEqual(
      await ready.executeTerminalCommand({ command: 'sleep', args: ['10'] }, { timeoutSeconds: 0.001 }),
      {
        terminalId: 'term-interrupt-1',
        output: 'interrupted 1\n',
        truncated: false,
        exitStatus: { exitCode: null, signal: 'timeout' }
      }
    )

    const controller = new AbortController()
    controller.abort()
    const bashResult = await tools.get('bash').execute('bash-aborted', { command: 'sleep 10' }, controller.signal)
    assert.deepEqual(bashResult.content, [{ type: 'text', text: 'interrupted 2\n' }])
    assert.deepEqual(bashResult.details.exitStatus, { exitCode: null, signal: 'aborted' })

    const expectedShell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || 'bash'
    const expectedShellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'sleep 10'] : ['-lc', 'sleep 10']
    assert.deepEqual(calls, [
      { method: 'terminal/create', params: { command: 'sleep', args: ['10'] } },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-interrupt-1' } },
      { method: 'terminal/kill', params: { terminalId: 'term-interrupt-1' } },
      { method: 'terminal/output', params: { terminalId: 'term-interrupt-1' } },
      { method: 'terminal/release', params: { terminalId: 'term-interrupt-1' } },
      {
        method: 'terminal/create',
        params: {
          command: expectedShell,
          args: expectedShellArgs,
          cwd: '/tmp/project'
        }
      },
      { method: 'terminal/wait_for_exit', params: { terminalId: 'term-interrupt-2' } },
      { method: 'terminal/kill', params: { terminalId: 'term-interrupt-2' } },
      { method: 'terminal/output', params: { terminalId: 'term-interrupt-2' } }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
