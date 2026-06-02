import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectMcpStdioServers, normalizeStdioMcpServers } from '../../src/pi-extension/mcp-stdio.js'

test('MCP stdio bridge: normalizes ACP stdio server configs and skips unsupported transports', () => {
  const normalized = normalizeStdioMcpServers({
    cwd: '/tmp/project',
    mcpServers: [
      {
        type: 'stdio',
        name: 'demo',
        command: '/bin/demo',
        args: ['--ok', 3],
        env: [{ name: 'TOKEN', value: 'secret' }]
      },
      { type: 'http', name: 'remote', url: 'https://mcp.test', headers: [] }
    ]
  })

  assert.deepEqual(normalized.stdio, [
    {
      name: 'demo',
      command: '/bin/demo',
      args: ['--ok'],
      env: { TOKEN: 'secret' },
      cwd: '/tmp/project'
    }
  ])
  assert.deepEqual(normalized.unsupported, [{ name: 'remote', transport: 'http' }])
})

test('MCP stdio bridge: connects, registers tools, and calls tools through pi extension API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-test-'))
  const serverPath = join(dir, 'fake-mcp-server.mjs')
  writeFileSync(serverPath, fakeMcpServerSource(), 'utf8')

  const registeredTools: any[] = []
  const emitted: Array<{ channel: string; data: unknown }> = []

  try {
    const runtime = await connectMcpStdioServers(
      {
        cwd: dir,
        mcpServers: [
          {
            name: 'demo',
            command: process.execPath,
            args: [serverPath],
            env: [{ name: 'TOKEN', value: 'secret-token' }]
          }
        ]
      },
      {
        registerTool: tool => registeredTools.push(tool)
      },
      {
        timeoutMs: 2_000,
        emit: (channel, data) => emitted.push({ channel, data })
      }
    )

    assert.equal(registeredTools.length, 1)
    assert.equal(registeredTools[0].name, 'mcp_demo_echo')
    assert.deepEqual(runtime.getStatus(), [{ name: 'demo', state: 'connected', toolCount: 1 }])
    assert.deepEqual(runtime.getRegisteredTools(), [
      { serverName: 'demo', mcpToolName: 'echo', piToolName: 'mcp_demo_echo' }
    ])
    assert.equal(
      emitted.some(event => event.channel === 'acp:mcp:connected'),
      true
    )

    const updates: unknown[] = []
    const result = await registeredTools[0].execute(
      'tool-call-1',
      { message: 'hello' },
      undefined,
      (partial: unknown) => updates.push(partial)
    )

    assert.equal(updates.length, 1)
    assert.deepEqual(result.content[0], { type: 'text', text: 'echo:hello' })
    assert.match(result.content[1].text, /secret-token/)
    assert.deepEqual(result.details, {
      serverName: 'demo',
      mcpToolName: 'echo',
      piToolName: 'mcp_demo_echo',
      structuredContent: { token: 'secret-token' }
    })

    await assert.rejects(() => registeredTools[0].execute('tool-call-2', { fail: true }), /requested failure/)

    const resourceResult = await registeredTools[0].execute('tool-call-3', { resource: true })
    assert.deepEqual(
      resourceResult.content.map((block: any) => block.text),
      [
        'resource output',
        [
          '[MCP resource link: Project File <file:///tmp/project/readme.md>]',
          'description: Readme file',
          'mimeType: text/markdown',
          'size: 12'
        ].join('\n'),
        '[MCP resource: file:///tmp/project/readme.md (text/markdown)]\n# Readme',
        '[MCP resource: file:///tmp/project/blob.bin (application/octet-stream), 5 bytes]',
        '[MCP audio: audio/wav]'
      ]
    )
    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio bridge: drains verbose server stderr during startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-stderr-test-'))
  const serverPath = join(dir, 'stderr-mcp-server.mjs')
  writeFileSync(serverPath, noisyStderrMcpServerSource(), 'utf8')

  try {
    const runtime = await connectMcpStdioServers(
      {
        cwd: dir,
        mcpServers: [
          {
            name: 'stderr-demo',
            command: process.execPath,
            args: [serverPath],
            env: []
          }
        ]
      },
      {},
      { timeoutMs: 2_000 }
    )

    assert.deepEqual(runtime.getStatus(), [{ name: 'stderr-demo', state: 'connected', toolCount: 0 }])
    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio bridge: registers newly listed tools after tools/list_changed notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-dynamic-test-'))
  const serverPath = join(dir, 'dynamic-mcp-server.mjs')
  writeFileSync(serverPath, dynamicMcpServerSource(), 'utf8')

  const registeredTools: any[] = []
  const emitted: Array<{ channel: string; data: unknown }> = []

  try {
    const runtime = await connectMcpStdioServers(
      {
        cwd: dir,
        mcpServers: [
          {
            name: 'demo',
            command: process.execPath,
            args: [serverPath],
            env: []
          }
        ]
      },
      {
        registerTool: tool => registeredTools.push(tool)
      },
      {
        timeoutMs: 2_000,
        emit: (channel, data) => emitted.push({ channel, data })
      }
    )

    await waitFor(() => registeredTools.length === 2)
    assert.deepEqual(
      registeredTools.map(tool => tool.name),
      ['mcp_demo_echo', 'mcp_demo_later']
    )
    assert.deepEqual(runtime.getStatus(), [{ name: 'demo', state: 'connected', toolCount: 2 }])
    assert.deepEqual(runtime.getRegisteredTools(), [
      { serverName: 'demo', mcpToolName: 'echo', piToolName: 'mcp_demo_echo' },
      { serverName: 'demo', mcpToolName: 'later', piToolName: 'mcp_demo_later' }
    ])
    assert.equal(
      emitted.some(event => event.channel === 'acp:mcp:tools_changed'),
      true
    )

    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio bridge: replaces removed tools with disabled stubs and deactivates them after tools/list_changed notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-removal-test-'))
  const serverPath = join(dir, 'removing-mcp-server.mjs')
  writeFileSync(serverPath, removingMcpServerSource(), 'utf8')

  const registeredTools = new Map<string, any>()
  const emitted: Array<{ channel: string; data: unknown }> = []
  let activeTools = ['read', 'mcp_demo_echo', 'write']
  const setActiveToolCalls: string[][] = []

  try {
    const runtime = await connectMcpStdioServers(
      {
        cwd: dir,
        mcpServers: [
          {
            name: 'demo',
            command: process.execPath,
            args: [serverPath],
            env: []
          }
        ]
      },
      {
        getActiveTools: () => activeTools,
        registerTool: tool => registeredTools.set(tool.name, tool),
        setActiveTools: toolNames => {
          activeTools = toolNames
          setActiveToolCalls.push(toolNames)
        }
      },
      {
        timeoutMs: 2_000,
        emit: (channel, data) => emitted.push({ channel, data })
      }
    )

    assert.deepEqual(runtime.getRegisteredTools(), [
      { serverName: 'demo', mcpToolName: 'echo', piToolName: 'mcp_demo_echo' }
    ])
    assert.equal(registeredTools.get('mcp_demo_echo')?.description, 'Echo a message')

    await waitFor(() => runtime.getRegisteredTools().length === 0)
    assert.deepEqual(runtime.getStatus(), [{ name: 'demo', state: 'connected', toolCount: 0 }])
    assert.equal(
      emitted.some(event => event.channel === 'acp:mcp:tool_removed'),
      true
    )
    assert.deepEqual(activeTools, ['read', 'write'])
    assert.deepEqual(setActiveToolCalls, [['read', 'write']])

    const disabled = registeredTools.get('mcp_demo_echo')
    assert.ok(disabled)
    assert.match(disabled.description, /no longer advertised/)
    assert.deepEqual(disabled.parameters, { type: 'object', properties: {}, additionalProperties: false })
    await assert.rejects(() => disabled.execute('tool-call-removed', {}), /no longer advertised/)

    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio bridge: exposes MCP resources through service methods and tool shims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-resource-test-'))
  const serverPath = join(dir, 'resource-mcp-server.mjs')
  writeFileSync(serverPath, resourceMcpServerSource(), 'utf8')

  const registeredTools: any[] = []
  const emitted: Array<{ channel: string; data: unknown }> = []

  try {
    const runtime = await connectMcpStdioServers(
      {
        cwd: dir,
        mcpServers: [
          {
            name: 'demo',
            command: process.execPath,
            args: [serverPath],
            env: []
          }
        ]
      },
      {
        registerTool: tool => registeredTools.push(tool)
      },
      {
        timeoutMs: 2_000,
        emit: (channel, data) => emitted.push({ channel, data })
      }
    )

    assert.deepEqual(
      registeredTools.map(tool => tool.name),
      ['mcp_demo_list_resources', 'mcp_demo_read_resource']
    )
    assert.deepEqual(runtime.getRegisteredResourceTools(), [
      {
        serverName: 'demo',
        listToolName: 'mcp_demo_list_resources',
        readToolName: 'mcp_demo_read_resource'
      }
    ])

    await waitFor(() => runtime.getResources()[0]?.resources.length === 2)
    assert.deepEqual(runtime.getStatus(), [{ name: 'demo', state: 'connected', toolCount: 0, resourceCount: 2 }])
    assert.equal(
      emitted.some(event => event.channel === 'acp:mcp:resources_changed'),
      true
    )

    const listings = await runtime.listResources('demo')
    assert.deepEqual(listings, [
      {
        serverName: 'demo',
        resources: [
          {
            uri: 'memory://note',
            name: 'note',
            title: 'Note',
            description: 'A text note',
            mimeType: 'text/plain',
            size: 14
          },
          {
            uri: 'memory://image',
            name: 'image',
            mimeType: 'image/png'
          }
        ]
      }
    ])

    assert.deepEqual(await runtime.readResource('demo', 'memory://note'), {
      contents: [{ uri: 'memory://note', mimeType: 'text/plain', text: 'Hello resource' }]
    })

    const listResult = await registeredTools[0].execute('tool-call-list', {})
    assert.match(listResult.content[0].text, /Note <memory:\/\/note>/)
    assert.match(listResult.content[0].text, /image <memory:\/\/image>/)
    assert.equal(listResult.details.resourceCount, 2)

    const readTextResult = await registeredTools[1].execute('tool-call-read-text', { uri: 'memory://note' })
    assert.deepEqual(readTextResult.content, [
      { type: 'text', text: '[MCP resource: memory://note (text/plain)]\nHello resource' }
    ])
    assert.deepEqual(readTextResult.details.contents, [{ uri: 'memory://note', mimeType: 'text/plain', type: 'text' }])

    const readImageResult = await registeredTools[1].execute('tool-call-read-image', { uri: 'memory://image' })
    assert.deepEqual(readImageResult.content, [
      { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }
    ])

    await assert.rejects(() => registeredTools[1].execute('tool-call-missing-uri', {}), /uri is required/)
    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio bridge: records failed server startup without failing extension load', async () => {
  const registeredTools: any[] = []
  const runtime = await connectMcpStdioServers(
    {
      mcpServers: [{ name: 'missing', command: '/definitely/not/a/mcp-server', args: [], env: [] }]
    },
    { registerTool: tool => registeredTools.push(tool) },
    { timeoutMs: 500 }
  )

  assert.deepEqual(registeredTools, [])
  assert.equal(runtime.getStatus()[0]?.name, 'missing')
  assert.equal(runtime.getStatus()[0]?.state, 'failed')
  assert.match(runtime.getStatus()[0]?.error ?? '', /ENOENT|not\/a\/mcp-server/)
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function fakeMcpServerSource(): string {
  return `
let buffer = ''

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') return

  if (message.method === 'tools/list') {
    send(message.id, {
      tools: [{
        name: 'echo',
        description: 'Echo a message',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            fail: { type: 'boolean' }
          },
          required: []
        },
        annotations: { readOnlyHint: true }
      }]
    })
    return
  }

  if (message.method === 'tools/call') {
    if (message.params?.arguments?.fail) {
      send(message.id, {
        content: [{ type: 'text', text: 'requested failure' }],
        isError: true
      })
      return
    }

    if (message.params?.arguments?.resource) {
      send(message.id, {
        content: [
          { type: 'text', text: 'resource output' },
          {
            type: 'resource_link',
            uri: 'file:///tmp/project/readme.md',
            name: 'readme.md',
            title: 'Project File',
            description: 'Readme file',
            mimeType: 'text/markdown',
            size: 12
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/project/readme.md',
              mimeType: 'text/markdown',
              text: '# Readme'
            }
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/project/blob.bin',
              mimeType: 'application/octet-stream',
              blob: Buffer.from('hello').toString('base64')
            }
          },
          { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }
        ],
        isError: false
      })
      return
    }

    send(message.id, {
      content: [{ type: 'text', text: 'echo:' + message.params.arguments.message }],
      structuredContent: { token: process.env.TOKEN ?? null },
      isError: false
    })
  }
}
`
}

function noisyStderrMcpServerSource(): string {
  return `
const chunk = Buffer.alloc(1024 * 1024, 'x')
for (let index = 0; index < 4; index += 1) {
  if (!process.stderr.write(chunk)) await new Promise(resolve => process.stderr.once('drain', resolve))
}

let buffer = ''

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'stderr-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') send(message.id, { tools: [] })
}
`
}

function resourceMcpServerSource(): string {
  return `
let buffer = ''
let includeImage = false

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: { listChanged: true } },
      serverInfo: { name: 'resource-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') {
    setTimeout(() => {
      includeImage = true
      notify('notifications/resources/list_changed', {})
    }, 25)
    return
  }

  if (message.method === 'tools/list') {
    send(message.id, { tools: [] })
    return
  }

  if (message.method === 'resources/list') {
    if (message.params?.cursor === 'page2') {
      send(message.id, {
        resources: includeImage ? [{ uri: 'memory://image', name: 'image', mimeType: 'image/png' }] : []
      })
      return
    }

    send(message.id, {
      resources: [{
        uri: 'memory://note',
        name: 'note',
        title: 'Note',
        description: 'A text note',
        mimeType: 'text/plain',
        size: 14
      }],
      nextCursor: includeImage ? 'page2' : undefined
    })
    return
  }

  if (message.method === 'resources/read') {
    if (message.params?.uri === 'memory://image') {
      send(message.id, {
        contents: [{ uri: 'memory://image', mimeType: 'image/png', blob: Buffer.from('png').toString('base64') }]
      })
      return
    }

    send(message.id, {
      contents: [{ uri: 'memory://note', mimeType: 'text/plain', text: 'Hello resource' }]
    })
  }
}
`
}

function removingMcpServerSource(): string {
  return `
let buffer = ''
let removed = false

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'removing-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') {
    setTimeout(() => {
      removed = true
      notify('notifications/tools/list_changed', {})
    }, 25)
    return
  }

  if (message.method === 'tools/list') {
    send(message.id, {
      tools: removed
        ? []
        : [{
            name: 'echo',
            description: 'Echo a message',
            inputSchema: { type: 'object', properties: {}, required: [] }
          }]
    })
  }
}
`
}

function dynamicMcpServerSource(): string {
  return `
let buffer = ''
let includeLater = false

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
}

function listTools() {
  const tools = [{
    name: 'echo',
    description: 'Echo a message',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }]
  if (includeLater) {
    tools.push({
      name: 'later',
      description: 'A dynamically listed tool',
      inputSchema: { type: 'object', properties: {}, required: [] }
    })
  }
  return tools
}

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'dynamic-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') {
    setTimeout(() => {
      includeLater = true
      notify('notifications/tools/list_changed', {})
    }, 25)
    return
  }

  if (message.method === 'tools/list') {
    send(message.id, { tools: listTools() })
  }
}
`
}
