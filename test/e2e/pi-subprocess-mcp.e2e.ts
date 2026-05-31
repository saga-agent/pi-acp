import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'
import { ACP_BRIDGE_EXTENSION_ENV, type PiAcpBridgeSetup } from '../../src/pi-rpc/bridge-extension.js'
import { startBridgeRpcServer } from '../../src/pi-rpc/bridge-rpc.js'

const piCommand = resolvePiCommand()
const bridgeExtensionPath = resolve(process.cwd(), 'dist', 'pi-extension', 'acp-bridge.js')
const skipReason = !piCommand
  ? 'set PI_ACP_TEST_PI_COMMAND or clone/build pi next to pi-acp'
  : !existsSync(bridgeExtensionPath)
    ? 'run npm run build before pi subprocess E2E'
    : false
const PI_ENV_KEYS = [ACP_BRIDGE_EXTENSION_ENV, 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK']

test(
  'pi subprocess E2E: bridge extension connects stdio MCP and registers its tool with pi',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-mcp-'))
    const serverPath = join(dir, 'fake-mcp-server.mjs')
    writeFileSync(serverPath, fakeMcpServerSource(), 'utf8')

    const previousEnv = setupPiEnv(dir)

    let proc: PiRpcProcess | null = null
    try {
      const setup: PiAcpBridgeSetup = {
        version: 1,
        lifecycle: 'new',
        cwd: dir,
        sessionId: null,
        mcpServers: [
          {
            name: 'demo',
            command: process.execPath,
            args: [serverPath],
            env: [{ name: 'TOKEN', value: 'e2e-secret' }]
          }
        ],
        clientCapabilities: null,
        createdAt: '2026-05-30T00:00:00.000Z'
      }

      proc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'session.jsonl'),
        bridgeSetup: setup
      })

      const commands = (await proc.getCommands()) as { commands?: Array<{ name?: string }> }
      assert.equal(
        commands.commands?.some(command => command.name === 'acp-bridge-status'),
        true
      )

      const events: PiRpcEvent[] = []
      proc.onEvent(event => events.push(event))
      await proc.prompt('/acp-bridge-status')

      const statusEvent = await waitFor(() =>
        events.find(
          event =>
            event.type === 'extension_ui_request' &&
            event.method === 'notify' &&
            typeof event.message === 'string' &&
            event.message.startsWith('ACP bridge status: ')
        )
      )

      const status = JSON.parse(String(statusEvent.message).replace(/^ACP bridge status: /, ''))
      assert.deepEqual(status.mcpStatus, [{ name: 'demo', state: 'connected', toolCount: 1 }])
      assert.deepEqual(status.registeredMcpTools, [
        { serverName: 'demo', mcpToolName: 'echo', piToolName: 'mcp_demo_echo' }
      ])
      assert.equal(status.piToolNames.includes('mcp_demo_echo'), true)
    } finally {
      proc?.dispose()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  'pi subprocess E2E: bridge extension reports failed stdio MCP setup through status command',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-mcp-fail-'))
    const previousEnv = setupPiEnv(dir)

    let proc: PiRpcProcess | null = null
    try {
      proc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'session.jsonl'),
        bridgeSetup: {
          version: 1,
          lifecycle: 'new',
          cwd: dir,
          sessionId: null,
          mcpServers: [{ name: 'broken', command: '/definitely/not/a/mcp-server', args: [], env: [] }],
          clientCapabilities: null,
          createdAt: '2026-05-30T00:00:00.000Z'
        }
      })

      const status = await getBridgeStatus(proc)
      assert.equal(status.mcpStatus[0]?.name, 'broken')
      assert.equal(status.mcpStatus[0]?.state, 'failed')
      assert.match(status.mcpStatus[0]?.error ?? '', /ENOENT|not\/a\/mcp-server/)
      assert.deepEqual(status.registeredMcpTools, [])
      assert.equal(
        status.piToolNames.some((name: string) => name.startsWith('mcp_broken_')),
        false
      )
    } finally {
      proc?.dispose()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('pi subprocess E2E: bridge extension exposes MCP resource list and read paths', { skip: skipReason }, async () => {
  assert.ok(piCommand)

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-mcp-resource-'))
  const serverPath = join(dir, 'resource-mcp-server.mjs')
  writeFileSync(serverPath, resourceMcpServerSource(), 'utf8')

  const previousEnv = setupPiEnv(dir)
  let proc: PiRpcProcess | null = null

  try {
    proc = await PiRpcProcess.spawn({
      cwd: dir,
      piCommand,
      sessionPath: join(dir, 'session.jsonl'),
      bridgeSetup: {
        version: 1,
        lifecycle: 'new',
        cwd: dir,
        sessionId: null,
        mcpServers: [{ name: 'demo', command: process.execPath, args: [serverPath], env: [] }],
        clientCapabilities: null,
        createdAt: '2026-05-30T00:00:00.000Z'
      }
    })

    const status = await getBridgeStatus(proc)
    assert.deepEqual(status.mcpStatus, [{ name: 'demo', state: 'connected', toolCount: 0, resourceCount: 1 }])
    assert.deepEqual(status.registeredMcpTools, [])
    assert.deepEqual(status.registeredMcpResourceTools, [
      {
        serverName: 'demo',
        listToolName: 'mcp_demo_list_resources',
        readToolName: 'mcp_demo_read_resource'
      }
    ])
    assert.deepEqual(status.mcpResources, [
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
          }
        ]
      }
    ])
    assert.equal(status.piToolNames.includes('mcp_demo_list_resources'), true)
    assert.equal(status.piToolNames.includes('mcp_demo_read_resource'), true)

    const readEvent = await runCommandAndWaitForNotify(proc, '/acp-mcp-read-resource demo memory://note', message =>
      message.startsWith('ACP MCP resource: ')
    )
    const read = JSON.parse(String(readEvent.message).replace(/^ACP MCP resource: /, ''))
    assert.deepEqual(read, {
      serverName: 'demo',
      uri: 'memory://note',
      contents: [
        {
          uri: 'memory://note',
          mimeType: 'text/plain',
          type: 'text',
          text: 'Hello resource'
        }
      ]
    })
  } finally {
    proc?.dispose()
    restoreEnv(previousEnv)
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'pi subprocess E2E: terminal-capable bridge shadows bash with an extension tool',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-terminal-bash-'))
    const previousEnv = setupPiEnv(dir)
    const rpc = await startBridgeRpcServer((method, params) => {
      if (method === 'terminal/create') return { terminalId: 'term-e2e' }
      if (method === 'terminal/wait_for_exit') return { exitCode: 0, signal: null }
      if (method === 'terminal/output') return { output: 'terminal e2e\n', truncated: false }
      if (method === 'terminal/kill') return {}
      if (method === 'terminal/release') return {}
      throw new Error(`unexpected method ${method}: ${JSON.stringify(params)}`)
    })
    let proc: PiRpcProcess | null = null

    try {
      proc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'session.jsonl'),
        bridgeSetup: {
          version: 1,
          lifecycle: 'new',
          cwd: dir,
          sessionId: null,
          mcpServers: [],
          clientCapabilities: { terminal: true },
          adapterRpc: rpc.endpoint,
          createdAt: '2026-05-30T00:00:00.000Z'
        }
      })

      const status = await getBridgeStatus(proc)
      assert.equal(status.piToolNames.includes('acp_terminal_execute'), true)

      const bashTool = status.piTools.find((tool: any) => tool.name === 'bash')
      assert.notEqual(bashTool?.sourceInfo?.path, '<builtin:bash>')
      assert.match(String(bashTool?.sourceInfo?.path ?? ''), /acp-bridge/)
    } finally {
      proc?.dispose()
      rpc.close()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  'pi subprocess E2E: fs-capable bridge shadows read write and edit with extension tools',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-fs-tools-'))
    const previousEnv = setupPiEnv(dir)
    const rpc = await startBridgeRpcServer((method, params) => {
      if (method === 'fs/read_text_file') return { content: 'client fs e2e\n' }
      if (method === 'fs/write_text_file') return {}
      throw new Error(`unexpected method ${method}: ${JSON.stringify(params)}`)
    })
    let proc: PiRpcProcess | null = null

    try {
      proc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'session.jsonl'),
        bridgeSetup: {
          version: 1,
          lifecycle: 'new',
          cwd: dir,
          sessionId: null,
          mcpServers: [],
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          adapterRpc: rpc.endpoint,
          createdAt: '2026-05-30T00:00:00.000Z'
        }
      })

      const status = await getBridgeStatus(proc)
      for (const toolName of ['acp_read_text_file', 'acp_write_text_file', 'read', 'write', 'edit']) {
        assert.equal(status.piToolNames.includes(toolName), true)
      }

      for (const toolName of ['read', 'write', 'edit']) {
        const tool = status.piTools.find((candidate: any) => candidate.name === toolName)
        assert.notEqual(tool?.sourceInfo?.path, `<builtin:${toolName}>`)
        assert.match(String(tool?.sourceInfo?.path ?? ''), /acp-bridge/)
      }
    } finally {
      proc?.dispose()
      rpc.close()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  'pi subprocess E2E: separate active sessions keep MCP tool registrations isolated',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-mcp-concurrent-'))
    const serverA = join(dir, 'fake-mcp-server-a.mjs')
    const serverB = join(dir, 'fake-mcp-server-b.mjs')
    writeFileSync(serverA, fakeMcpServerSource(), 'utf8')
    writeFileSync(serverB, fakeMcpServerSource(), 'utf8')

    const previousEnv = setupPiEnv(dir)
    let procA: PiRpcProcess | null = null
    let procB: PiRpcProcess | null = null

    try {
      ;[procA, procB] = await Promise.all([
        PiRpcProcess.spawn({
          cwd: dir,
          piCommand,
          sessionPath: join(dir, 'session-a.jsonl'),
          bridgeSetup: {
            version: 1,
            lifecycle: 'new',
            cwd: dir,
            sessionId: null,
            mcpServers: [{ name: 'alpha', command: process.execPath, args: [serverA], env: [] }],
            clientCapabilities: null,
            createdAt: '2026-05-30T00:00:00.000Z'
          }
        }),
        PiRpcProcess.spawn({
          cwd: dir,
          piCommand,
          sessionPath: join(dir, 'session-b.jsonl'),
          bridgeSetup: {
            version: 1,
            lifecycle: 'new',
            cwd: dir,
            sessionId: null,
            mcpServers: [{ name: 'beta', command: process.execPath, args: [serverB], env: [] }],
            clientCapabilities: null,
            createdAt: '2026-05-30T00:00:00.000Z'
          }
        })
      ])

      const [statusA, statusB] = await Promise.all([getBridgeStatus(procA), getBridgeStatus(procB)])

      assert.deepEqual(statusA.mcpStatus, [{ name: 'alpha', state: 'connected', toolCount: 1 }])
      assert.deepEqual(statusA.registeredMcpTools, [
        { serverName: 'alpha', mcpToolName: 'echo', piToolName: 'mcp_alpha_echo' }
      ])
      assert.equal(statusA.piToolNames.includes('mcp_alpha_echo'), true)
      assert.equal(statusA.piToolNames.includes('mcp_beta_echo'), false)

      assert.deepEqual(statusB.mcpStatus, [{ name: 'beta', state: 'connected', toolCount: 1 }])
      assert.deepEqual(statusB.registeredMcpTools, [
        { serverName: 'beta', mcpToolName: 'echo', piToolName: 'mcp_beta_echo' }
      ])
      assert.equal(statusB.piToolNames.includes('mcp_beta_echo'), true)
      assert.equal(statusB.piToolNames.includes('mcp_alpha_echo'), false)
    } finally {
      procA?.dispose()
      procB?.dispose()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  'pi subprocess E2E: bridge extension connects stdio MCP for load and resume lifecycles',
  { skip: skipReason },
  async () => {
    assert.ok(piCommand)

    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-real-pi-mcp-lifecycle-'))
    const serverLoad = join(dir, 'fake-mcp-server-load.mjs')
    const serverResume = join(dir, 'fake-mcp-server-resume.mjs')
    writeFileSync(serverLoad, fakeMcpServerSource(), 'utf8')
    writeFileSync(serverResume, fakeMcpServerSource(), 'utf8')
    writePiSessionFile(join(dir, 'load.jsonl'), 'sess-load', dir)
    writePiSessionFile(join(dir, 'resume.jsonl'), 'sess-resume', dir)

    const previousEnv = setupPiEnv(dir)
    let loadProc: PiRpcProcess | null = null
    let resumeProc: PiRpcProcess | null = null

    try {
      loadProc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'load.jsonl'),
        bridgeSetup: {
          version: 1,
          lifecycle: 'load',
          cwd: dir,
          sessionId: 'sess-load',
          mcpServers: [{ name: 'loadsrv', command: process.execPath, args: [serverLoad], env: [] }],
          clientCapabilities: null,
          createdAt: '2026-05-30T00:00:00.000Z'
        }
      })

      resumeProc = await PiRpcProcess.spawn({
        cwd: dir,
        piCommand,
        sessionPath: join(dir, 'resume.jsonl'),
        bridgeSetup: {
          version: 1,
          lifecycle: 'resume',
          cwd: dir,
          sessionId: 'sess-resume',
          mcpServers: [{ name: 'resumesrv', command: process.execPath, args: [serverResume], env: [] }],
          clientCapabilities: null,
          createdAt: '2026-05-30T00:00:00.000Z'
        }
      })

      const [loadStatus, resumeStatus] = await Promise.all([getBridgeStatus(loadProc), getBridgeStatus(resumeProc)])

      assert.equal(loadStatus.publicSetup.lifecycle, 'load')
      assert.equal(loadStatus.publicSetup.sessionId, 'sess-load')
      assert.equal(loadStatus.publicSetup.mcpServerCount, 1)
      assert.deepEqual(loadStatus.mcpStatus, [{ name: 'loadsrv', state: 'connected', toolCount: 1 }])
      assert.equal(loadStatus.piToolNames.includes('mcp_loadsrv_echo'), true)

      assert.equal(resumeStatus.publicSetup.lifecycle, 'resume')
      assert.equal(resumeStatus.publicSetup.sessionId, 'sess-resume')
      assert.equal(resumeStatus.publicSetup.mcpServerCount, 1)
      assert.deepEqual(resumeStatus.mcpStatus, [{ name: 'resumesrv', state: 'connected', toolCount: 1 }])
      assert.equal(resumeStatus.piToolNames.includes('mcp_resumesrv_echo'), true)
    } finally {
      loadProc?.dispose()
      resumeProc?.dispose()
      restoreEnv(previousEnv)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

function resolvePiCommand(): string | null {
  const explicit = process.env.PI_ACP_TEST_PI_COMMAND
  if (explicit) return explicit

  const localPi = resolve(process.cwd(), '..', 'pi', 'packages', 'coding-agent', 'dist', 'cli.js')
  return existsSync(localPi) ? localPi : null
}

function setupPiEnv(dir: string): Map<string, string | undefined> {
  const previousEnv = stashEnv(PI_ENV_KEYS)
  process.env[ACP_BRIDGE_EXTENSION_ENV] = bridgeExtensionPath
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent')
  process.env.PI_OFFLINE = '1'
  process.env.PI_SKIP_VERSION_CHECK = '1'
  return previousEnv
}

function stashEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map(key => [key, process.env[key]]))
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function getBridgeStatus(proc: PiRpcProcess): Promise<any> {
  const commands = (await proc.getCommands()) as { commands?: Array<{ name?: string }> }
  assert.equal(
    commands.commands?.some(command => command.name === 'acp-bridge-status'),
    true
  )

  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  await proc.prompt('/acp-bridge-status')

  const statusEvent = await waitFor(() =>
    events.find(
      event =>
        event.type === 'extension_ui_request' &&
        event.method === 'notify' &&
        typeof event.message === 'string' &&
        event.message.startsWith('ACP bridge status: ')
    )
  )

  return JSON.parse(String(statusEvent.message).replace(/^ACP bridge status: /, ''))
}

async function runCommandAndWaitForNotify(
  proc: PiRpcProcess,
  command: string,
  predicate: (message: string) => boolean
): Promise<PiRpcEvent> {
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  await proc.prompt(command)

  return waitFor(() =>
    events.find(
      event =>
        event.type === 'extension_ui_request' &&
        event.method === 'notify' &&
        typeof event.message === 'string' &&
        predicate(event.message)
    )
  )
}

function writePiSessionFile(path: string, sessionId: string, cwd: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: '2026-05-30T00:00:00.000Z',
        cwd
      }),
      JSON.stringify({
        type: 'message',
        id: `${sessionId}-m1`,
        parentId: null,
        timestamp: '2026-05-30T00:00:01.000Z',
        message: { role: 'user', content: 'hello' }
      })
    ].join('\n') + '\n',
    'utf8'
  )
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value !== undefined) return value
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
            message: { type: 'string' }
          },
          required: []
        },
        annotations: { readOnlyHint: true }
      }]
    })
    return
  }

  if (message.method === 'tools/call') {
    send(message.id, {
      content: [{ type: 'text', text: 'echo:' + message.params.arguments.message }],
      structuredContent: { token: process.env.TOKEN ?? null },
      isError: false
    })
  }
}
`
}

function resourceMcpServerSource(): string {
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
      capabilities: { resources: {} },
      serverInfo: { name: 'resource-mcp', version: '1.0.0' }
    })
    return
  }

  if (message.method === 'notifications/initialized') return

  if (message.method === 'resources/list') {
    send(message.id, {
      resources: [{
        uri: 'memory://note',
        name: 'note',
        title: 'Note',
        description: 'A text note',
        mimeType: 'text/plain',
        size: 14
      }]
    })
    return
  }

  if (message.method === 'resources/read') {
    send(message.id, {
      contents: [{ uri: 'memory://note', mimeType: 'text/plain', text: 'Hello resource' }]
    })
  }
}
`
}
