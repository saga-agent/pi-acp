import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClientBridgeRpcHandler } from '../../src/acp/client-bridge.js'
import { PromptStopReasonOverrideStore } from '../../src/acp/client-stop-reasons.js'
import { PromptResourceStore } from '../../src/acp/prompt-resources.js'
import { PiAcpSession } from '../../src/acp/session.js'
import acpBridge from '../../src/pi-extension/acp-bridge.js'
import { ACP_BRIDGE_SETUP_ENV, type PiAcpBridgeSetup } from '../../src/pi-rpc/bridge-extension.js'
import { startBridgeRpcServer } from '../../src/pi-rpc/bridge-rpc.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession prompt turn: prompt resource links are exposed through the bridge service', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const promptResourceStore = new PromptResourceStore()
  const resource = {
    type: 'resource_link' as const,
    uri: 'file:///client/context.txt',
    name: 'context.txt',
    mimeType: 'text/plain'
  }
  conn.readTextFileContent = 'from client buffer\n'

  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true } },
    getSessionId: () => 's1',
    promptResourceStore
  })

  let listed: unknown
  let readResult: unknown

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    proc.emit({ type: 'agent_start' })
    listed = await bridge('resource/list_prompt_resource_links', {})
    readResult = await bridge('resource/read_prompt_resource', { uri: resource.uri })
    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge,
    promptResourceStore
  })

  const reason = await session.prompt('use the linked resource', [], [resource])
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(reason, 'end_turn')
  assert.deepEqual(listed, { resources: [resource] })
  assert.deepEqual(readResult, {
    contents: [{ uri: resource.uri, mimeType: 'text/plain', text: 'from client buffer\n' }]
  })
  assert.deepEqual(conn.readTextFileRequests, [{ sessionId: 's1', path: '/client/context.txt' }])
  assert.deepEqual(await bridge('resource/list_prompt_resource_links', {}), { resources: [] })
})

test('PiAcpSession prompt turn: bridge stop-reason override controls prompt response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const stopReasonOverrides = new PromptStopReasonOverrideStore()
  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: {},
    getSessionId: () => 's-stop-reason',
    stopReasonOverrides
  })

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    proc.emit({ type: 'agent_start' })
    await bridge('prompt/set_stop_reason', {
      stopReason: 'max_turn_requests',
      source: 'test-extension'
    })
    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's-stop-reason',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge,
    stopReasonOverrides
  })

  assert.equal(await session.prompt('run until limit'), 'max_turn_requests')
  assert.equal(stopReasonOverrides.take('s-stop-reason'), null)
})

test('PiAcpSession prompt turn: refusal restores history before resolving prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.commands = [{ name: 'acp-restore-refusal-history' }]
  const stopReasonOverrides = new PromptStopReasonOverrideStore()
  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: {},
    getSessionId: () => 's-refusal',
    stopReasonOverrides
  })

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    if (message === '/acp-restore-refusal-history') {
      await bridge('prompt/refusal_history_restore_result', {
        sessionId: 's-refusal',
        restored: true,
        source: 'pi-acp-bridge',
        safeLeafId: 'assistant-1',
        userEntryId: 'user-2'
      })
      return
    }

    proc.emit({ type: 'agent_start' })
    await bridge('prompt/set_stop_reason', {
      stopReason: 'refusal',
      source: 'test-extension'
    })
    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's-refusal',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge,
    stopReasonOverrides
  })

  assert.equal(await session.prompt('refuse this'), 'refusal')
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['refuse this', '/acp-restore-refusal-history']
  )
  assert.equal(stopReasonOverrides.takeRefusalHistoryRestore('s-refusal'), null)
})

test('PiAcpSession prompt turn: client fs bridge reads and writes through ACP client methods', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.readTextFileContent = 'before\n'

  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    getSessionId: () => 's1'
  })

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    proc.emit({ type: 'agent_start' })

    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'read-client-file',
      toolName: 'read',
      args: { path: '/client/file.txt' }
    })
    const read = (await bridge('fs/read_text_file', { path: '/client/file.txt' })) as { content: string }
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'read-client-file',
      toolName: 'read',
      isError: false,
      result: {
        content: [{ type: 'text', text: read.content }],
        details: { path: '/client/file.txt', source: 'acp-client-fs', tool: 'read' }
      }
    })

    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'write-client-file',
      toolName: 'write',
      args: { path: '/client/file.txt' }
    })
    const old = (await bridge('fs/read_text_file', { path: '/client/file.txt' })) as { content: string }
    await bridge('fs/write_text_file', { path: '/client/file.txt', content: 'after\n' })
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'write-client-file',
      toolName: 'write',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Successfully wrote 6 bytes to /client/file.txt.' }],
        details: {
          path: '/client/file.txt',
          oldText: old.content,
          newText: 'after\n',
          source: 'acp-client-fs',
          tool: 'write'
        }
      }
    })

    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge
  })

  const reason = await session.prompt('read then write the file')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(reason, 'end_turn')
  assert.deepEqual(conn.readTextFileRequests, [
    { sessionId: 's1', path: '/client/file.txt' },
    { sessionId: 's1', path: '/client/file.txt' }
  ])
  assert.deepEqual(conn.writeTextFileRequests, [{ sessionId: 's1', path: '/client/file.txt', content: 'after\n' }])

  const readUpdate = conn.updates.find(
    update => (update.update as any).toolCallId === 'read-client-file' && (update.update as any).status === 'completed'
  )
  assert.deepEqual((readUpdate?.update as any)?.content, [
    { type: 'content', content: { type: 'text', text: 'before\n' } }
  ])

  const writeUpdate = conn.updates.find(
    update => (update.update as any).toolCallId === 'write-client-file' && (update.update as any).status === 'completed'
  )
  assert.deepEqual((writeUpdate?.update as any)?.content, [
    { type: 'diff', path: '/client/file.txt', oldText: 'before\n', newText: 'after\n' },
    { type: 'content', content: { type: 'text', text: 'Successfully wrote 6 bytes to /client/file.txt.' } }
  ])
})

test('PiAcpSession prompt turn: bridge extension edit uses client fs and emits ACP edit diff', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const files = new Map<string, string>([['/workspace/edit.txt', 'alpha\nbeta\ngamma\n']])

  conn.readTextFile = async (params: unknown): Promise<{ content: string }> => {
    conn.readTextFileRequests.push(params)
    const path = (params as { path?: unknown }).path
    if (typeof path !== 'string') throw new Error('missing path')
    const content = files.get(path)
    if (content === undefined) throw new Error(`missing file ${path}`)
    return { content }
  }
  conn.writeTextFile = async (params: unknown): Promise<Record<string, never>> => {
    conn.writeTextFileRequests.push(params)
    const request = params as { path?: unknown; content?: unknown }
    if (typeof request.path !== 'string') throw new Error('missing path')
    if (typeof request.content !== 'string') throw new Error('missing content')
    files.set(request.path, request.content)
    return {}
  }

  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    getSessionId: () => 's1'
  })
  const rpc = await startBridgeRpcServer(bridge)
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-edit-'))
  const setupPath = join(dir, 'setup.json')
  const setup: PiAcpBridgeSetup = {
    version: 1,
    lifecycle: 'new',
    cwd: '/workspace',
    sessionId: 's1',
    mcpServers: [],
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    adapterRpc: rpc.endpoint,
    createdAt: '2026-05-30T00:00:00.000Z'
  }
  writeFileSync(setupPath, JSON.stringify(setup), 'utf8')

  const previous = process.env[ACP_BRIDGE_SETUP_ENV]
  process.env[ACP_BRIDGE_SETUP_ENV] = setupPath

  try {
    const tools = new Map<string, any>()
    await acpBridge({
      events: {
        emit: () => undefined,
        on: () => () => undefined
      },
      registerTool: (tool: any) => tools.set(tool.name, tool)
    } as any)
    const editTool = tools.get('edit')
    assert.ok(editTool, 'expected ACP bridge extension to register shadowed edit tool')

    proc.prompt = async (message: string, attachments: unknown[] = []) => {
      proc.prompts.push({ message, attachments })
      proc.emit({ type: 'agent_start' })
      const args = {
        path: 'edit.txt',
        edits: [
          { oldText: 'alpha', newText: 'ALPHA' },
          { oldText: 'gamma', newText: 'GAMMA' }
        ]
      }
      proc.emit({ type: 'tool_execution_start', toolCallId: 'edit-client-file', toolName: 'edit', args })
      const result = await editTool.execute('edit-client-file', args)
      proc.emit({
        type: 'tool_execution_end',
        toolCallId: 'edit-client-file',
        toolName: 'edit',
        isError: false,
        result
      })
      proc.emit({ type: 'agent_end' })
    }

    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: '/workspace',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: [],
      bridgeRpcHandler: bridge
    })

    const reason = await session.prompt('edit the client file')
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(reason, 'end_turn')
    assert.equal(files.get('/workspace/edit.txt'), 'ALPHA\nbeta\nGAMMA\n')
    assert.deepEqual(conn.readTextFileRequests, [{ sessionId: 's1', path: '/workspace/edit.txt' }])
    assert.deepEqual(conn.writeTextFileRequests, [
      { sessionId: 's1', path: '/workspace/edit.txt', content: 'ALPHA\nbeta\nGAMMA\n' }
    ])

    const start = conn.updates.find(
      update => (update.update as any).toolCallId === 'edit-client-file' && update.update.sessionUpdate === 'tool_call'
    )
    assert.equal((start?.update as any)?.kind, 'edit')
    assert.deepEqual((start?.update as any)?.locations, [{ path: '/workspace/edit.txt' }])

    const end = conn.updates.find(
      update =>
        (update.update as any).toolCallId === 'edit-client-file' && (update.update as any).status === 'completed'
    )
    assert.deepEqual((end?.update as any)?.content, [
      {
        type: 'diff',
        path: '/workspace/edit.txt',
        oldText: 'alpha\nbeta\ngamma\n',
        newText: 'ALPHA\nbeta\nGAMMA\n'
      },
      {
        type: 'content',
        content: { type: 'text', text: 'Successfully replaced 2 block(s) in /workspace/edit.txt.' }
      }
    ])
  } finally {
    rpc.close()
    if (previous === undefined) delete process.env[ACP_BRIDGE_SETUP_ENV]
    else process.env[ACP_BRIDGE_SETUP_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PiAcpSession prompt turn: terminal bridge emits terminal content and releases after update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.terminalId = 'term-prompt-turn'
  conn.terminalOutput = { output: 'terminal done\n', truncated: false, exitStatus: { exitCode: 0, signal: null } }
  conn.terminalExitStatus = { exitCode: 0, signal: null }

  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => 's1'
  })

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    proc.emit({ type: 'agent_start' })
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'bash-terminal',
      toolName: 'bash',
      args: { command: 'echo hi' }
    })

    const created = (await bridge('terminal/create', {
      command: 'bash',
      args: ['-lc', 'echo hi'],
      cwd: '/workspace'
    })) as { terminalId: string }
    const exitStatus = await bridge('terminal/wait_for_exit', { terminalId: created.terminalId })
    const output = (await bridge('terminal/output', { terminalId: created.terminalId })) as {
      output: string
      truncated: boolean
    }

    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'bash-terminal',
      toolName: 'bash',
      isError: false,
      result: {
        content: [{ type: 'text', text: output.output }],
        details: {
          terminalId: created.terminalId,
          output: output.output,
          truncated: output.truncated,
          exitStatus,
          terminalRelease: 'pi-acp-after-tool-call-update',
          source: 'acp-client-terminal',
          tool: 'bash'
        }
      }
    })

    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge,
    terminalBackedToolNames: ['bash', 'acp_terminal_execute']
  })

  const reason = await session.prompt('run a command')
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(reason, 'end_turn')
  assert.deepEqual(conn.createTerminalRequests, [
    { sessionId: 's1', command: 'bash', args: ['-lc', 'echo hi'], cwd: '/workspace' }
  ])
  assert.equal(conn.terminalReleaseCount, 1)

  const start = conn.updates.find(
    update => (update.update as any).toolCallId === 'bash-terminal' && update.update.sessionUpdate === 'tool_call'
  )
  assert.equal((start?.update as any)?.kind, 'execute')

  const end = conn.updates.find(
    update => (update.update as any).toolCallId === 'bash-terminal' && (update.update as any).status === 'completed'
  )
  assert.deepEqual((end?.update as any)?.content, [
    { type: 'terminal', terminalId: 'term-prompt-turn' },
    { type: 'content', content: { type: 'text', text: 'terminal done\n' } }
  ])
})

test('PiAcpSession prompt turn: interrupted terminal is killed and still released after update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.terminalId = 'term-interrupted'
  conn.terminalOutput = { output: 'interrupted\n', truncated: false }

  const bridge = createClientBridgeRpcHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => 's1'
  })

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    proc.emit({ type: 'agent_start' })
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'bash-interrupted',
      toolName: 'bash',
      args: { command: 'sleep 10' }
    })

    const created = (await bridge('terminal/create', {
      command: 'bash',
      args: ['-lc', 'sleep 10'],
      cwd: '/workspace'
    })) as { terminalId: string }
    await bridge('terminal/kill', { terminalId: created.terminalId })
    const output = (await bridge('terminal/output', { terminalId: created.terminalId })) as {
      output: string
      truncated: boolean
    }

    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'bash-interrupted',
      toolName: 'bash',
      isError: false,
      result: {
        content: [{ type: 'text', text: output.output }],
        details: {
          terminalId: created.terminalId,
          output: output.output,
          truncated: output.truncated,
          exitStatus: { exitCode: null, signal: 'aborted' },
          terminalRelease: 'pi-acp-after-tool-call-update',
          source: 'acp-client-terminal',
          tool: 'bash'
        }
      }
    })

    proc.emit({ type: 'agent_end' })
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: '/workspace',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: bridge,
    terminalBackedToolNames: ['bash', 'acp_terminal_execute']
  })

  const reason = await session.prompt('run a command that gets interrupted')
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(reason, 'end_turn')
  assert.equal(conn.terminalKillCount, 1)
  assert.equal(conn.terminalReleaseCount, 1)

  const end = conn.updates.find(
    update => (update.update as any).toolCallId === 'bash-interrupted' && (update.update as any).status === 'completed'
  )
  assert.deepEqual((end?.update as any)?.content, [
    { type: 'terminal', terminalId: 'term-interrupted' },
    { type: 'content', content: { type: 'text', text: 'interrupted\n' } }
  ])
})
