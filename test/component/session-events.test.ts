import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptStopReasonOverrideStore } from '../../src/acp/client-stop-reasons.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: emits complete config_option_update for pi model_update events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }
    ]
  })
  proc.getState = async () => ({
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'model_update',
    model: { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    source: 'set'
  })

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const configUpdate = conn.updates.find(update => update.update.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)

  const modelOption = (configUpdate.update as any).configOptions.find((option: any) => option.id === 'model')
  assert.equal(modelOption.currentValue, 'anthropic/claude-sonnet-4')
  assert.ok(modelOption.options.some((option: any) => option.value === 'anthropic/claude-sonnet-4'))

  const thoughtOption = (configUpdate.update as any).configOptions.find((option: any) => option.id === 'thought_level')
  assert.equal(thoughtOption.currentValue, 'medium')
})

test('PiAcpSession: emits current_mode_update and complete config_option_update for pi thinking_level_update events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }]
  })
  proc.getState = async () => ({
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'thinking_level_update',
    level: 'high',
    previousLevel: 'medium'
  })

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const currentModeUpdate = conn.updates.find(update => update.update.sessionUpdate === 'current_mode_update')
  assert.ok(currentModeUpdate)
  assert.equal((currentModeUpdate.update as any).currentModeId, 'high')

  const configUpdate = conn.updates.find(update => update.update.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)

  const modelOption = (configUpdate.update as any).configOptions.find((option: any) => option.id === 'model')
  assert.equal(modelOption.currentValue, 'openai/gpt-5')

  const thoughtOption = (configUpdate.update as any).configOptions.find((option: any) => option.id === 'thought_level')
  assert.equal(thoughtOption.currentValue, 'high')
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
})

test('PiAcpSession: keeps streamed tool call status monotonic and rawInput current', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 'streamed-write',
        name: 'write',
        partialArgs: '{"path":"/tmp/streamed.txt","content":"draft"}'
      }
    }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'streamed-write',
    toolName: 'write',
    args: { path: '/tmp/streamed.txt', content: 'final' }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: {
        id: 'streamed-write',
        name: 'write',
        partialArgs: '{"path":"/tmp/streamed.txt","content":"late"}'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(update => ({
      update: update.update.sessionUpdate,
      status: (update.update as any).status,
      rawInput: (update.update as any).rawInput,
      locations: (update.update as any).locations
    })),
    [
      {
        update: 'tool_call',
        status: 'pending',
        rawInput: { path: '/tmp/streamed.txt', content: 'draft' },
        locations: [{ path: '/tmp/streamed.txt' }]
      },
      {
        update: 'tool_call_update',
        status: 'in_progress',
        rawInput: { path: '/tmp/streamed.txt', content: 'final' },
        locations: [{ path: '/tmp/streamed.txt' }]
      },
      {
        update: 'tool_call_update',
        status: 'in_progress',
        rawInput: { path: '/tmp/streamed.txt', content: 'late' },
        locations: [{ path: '/tmp/streamed.txt' }]
      }
    ]
  )
})

test('PiAcpSession: emits failed tool output as failed tool_call_update content', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const failure = { content: [{ type: 'text', text: 'permission denied' }], details: { code: 'EACCES' } }
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'failed-read',
    toolName: 'read',
    args: { path: '/tmp/secret.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'failed-read',
    isError: true,
    result: failure
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.deepEqual(conn.updates[1]!.update, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'failed-read',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
    rawOutput: failure
  })
})

test('PiAcpSession: duplicate tool_execution_start updates instead of duplicating tool_call', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'dup-start', toolName: 'read', args: { path: '/tmp/one.txt' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'dup-start', toolName: 'read', args: { path: '/tmp/two.txt' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(update => ({
      update: update.update.sessionUpdate,
      status: (update.update as any).status,
      locations: (update.update as any).locations,
      rawInput: (update.update as any).rawInput
    })),
    [
      {
        update: 'tool_call',
        status: 'in_progress',
        locations: [{ path: '/tmp/one.txt' }],
        rawInput: { path: '/tmp/one.txt' }
      },
      {
        update: 'tool_call_update',
        status: 'in_progress',
        locations: [{ path: '/tmp/two.txt' }],
        rawInput: { path: '/tmp/two.txt' }
      }
    ]
  )
})

test('PiAcpSession: emits terminal tool content before releasing adapter-managed terminal', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const releases: Array<{ method: string; params: unknown; updateCount: number }> = []

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: async (method, params) => {
      releases.push({ method, params, updateCount: conn.updates.length })
      return {}
    }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-terminal',
    toolName: 'acp_terminal_execute',
    args: { command: 'npm' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-terminal',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'terminal done\n' }],
      details: {
        terminalId: 'term-client-1',
        source: 'acp-client-terminal',
        terminalRelease: 'pi-acp-after-tool-call-update'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    { type: 'terminal', terminalId: 'term-client-1' },
    { type: 'content', content: { type: 'text', text: 'terminal done\n' } }
  ])
  assert.deepEqual(releases, [{ method: 'terminal/release', params: { terminalId: 'term-client-1' }, updateCount: 2 }])
})

test('PiAcpSession: does not emit terminal content for non-adapter-managed terminal details', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const releases: Array<{ method: string; params: unknown }> = []

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    bridgeRpcHandler: async (method, params) => {
      releases.push({ method, params })
      return {}
    }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'local-terminal',
    toolName: 'bash',
    args: { command: 'echo hi' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'local-terminal',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'local terminal text\n' }],
      details: {
        terminalId: 'local-term-1'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: 'local terminal text\n' } }
  ])
  assert.deepEqual(releases, [])
})

test('PiAcpSession: maps core pi tool names to stable ACP kinds', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: '/tmp/a.txt' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: { path: '/tmp/b.txt' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args: { path: '/tmp/c.txt' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'grep-1', toolName: 'grep', args: { pattern: 'TODO' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'find-1', toolName: 'find', args: { pattern: '*.ts' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'ls-1', toolName: 'ls', args: { path: '/tmp' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'search-1', toolName: 'search', args: { query: 'pi' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'rg-1', toolName: 'rg', args: { pattern: 'ACP' } })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'delete-1',
    toolName: 'delete_file',
    args: { path: '/tmp/old.txt' }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'move-1',
    toolName: 'rename_file',
    args: { from: '/tmp/a', to: '/tmp/b' }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'fetch-1',
    toolName: 'web_fetch',
    args: { url: 'https://example.com' }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'think-1', toolName: 'reasoning', args: { goal: 'plan' } })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'switch-mode-1',
    toolName: 'switch_mode',
    args: { mode: 'plan' }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'pwd' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'custom-1', toolName: 'custom_tool', args: {} })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(update => ({
      id: (update.update as any).toolCallId,
      kind: (update.update as any).kind
    })),
    [
      { id: 'read-1', kind: 'read' },
      { id: 'write-1', kind: 'edit' },
      { id: 'edit-1', kind: 'edit' },
      { id: 'grep-1', kind: 'search' },
      { id: 'find-1', kind: 'search' },
      { id: 'ls-1', kind: 'search' },
      { id: 'search-1', kind: 'search' },
      { id: 'rg-1', kind: 'search' },
      { id: 'delete-1', kind: 'delete' },
      { id: 'move-1', kind: 'move' },
      { id: 'fetch-1', kind: 'fetch' },
      { id: 'think-1', kind: 'think' },
      { id: 'switch-mode-1', kind: 'switch_mode' },
      { id: 'bash-1', kind: 'execute' },
      { id: 'custom-1', kind: 'other' }
    ]
  )
})

test('PiAcpSession: marks terminal-backed bash as execute kind', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    terminalBackedToolNames: ['bash']
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't-bash', toolName: 'bash', args: { command: 'pwd' } })
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt resolves end_turn on agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: extension command prompt resolves end_turn when pi stays idle without agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let getStateCount = 0
  proc.getState = async () => {
    getStateCount += 1
    return { isStreaming: false, isCompacting: false }
  }
  proc.getMessages = async () => ({
    messages: [
      {
        role: 'custom',
        customType: 'extension.command',
        content: 'EXTENSION STARTUP\nResources from selected profile:\n- none',
        display: true,
        timestamp: 1
      }
    ]
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const keepAlive = setTimeout(() => {}, 1_100)
  try {
    const reason = await session.prompt('/extension startup')

    assert.equal(reason, 'end_turn')
    assert.equal(proc.prompts.length, 1)
    assert.equal(proc.prompts[0]!.message, '/extension startup')
    assert.equal(getStateCount, 1)

    const runningStates = conn.updates
      .filter(u => u.update.sessionUpdate === 'session_info_update')
      .map(u => (u.update as any)._meta?.piAcp?.running)

    assert.deepEqual(runningStates, [true, false])

    const texts = conn.updates.map(u => (u.update as any).content?.text).filter(Boolean)
    assert.ok(texts.some(text => text.includes('EXTENSION STARTUP')))
  } finally {
    clearTimeout(keepAlive)
  }
})

test('PiAcpSession: maps pi length stop reason to ACP max_tokens', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'length' }]
  })

  const reason = await p
  assert.equal(reason, 'max_tokens')
})

test('PiAcpSession: maps future pi max_turn_requests stop reason', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's-max-turn-requests',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'max_turn_requests' }]
  })

  assert.equal(await p, 'max_turn_requests')
})

test('PiAcpSession: maps refusal only after history restore succeeds', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const stopReasonOverrides = new PromptStopReasonOverrideStore()
  proc.commands = [{ name: 'acp-restore-refusal-history' }]
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    if (message === '/acp-restore-refusal-history') {
      stopReasonOverrides.recordRefusalHistoryRestore('s-refusal', { restored: true })
    }
  }

  const session = new PiAcpSession({
    sessionId: 's-refusal',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    stopReasonOverrides
  })

  const p = session.prompt('hello')
  proc.emit({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'refusal' }]
  })

  assert.equal(await p, 'refusal')
})

test('PiAcpSession: downgrades refusal when history restore is unavailable', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's-refusal-no-restore',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'refusal' }]
  })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: prompt failure emits visible error before resolving error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async () => {
    throw new Error('provider exploded')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const reason = await session.prompt('hello')
  assert.equal(reason, 'error')

  const texts = conn.updates.map(u => (u.update as any).content?.text).filter(Boolean)
  assert.ok(texts.some(text => text === 'Prompt failed: provider exploded'))
})

test('PiAcpSession: agent_end error emits visible error before resolving error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const pending = session.prompt('hello')
  proc.emit({
    type: 'agent_end',
    willRetry: false,
    messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'provider returned 500' }]
  })

  const reason = await pending
  assert.equal(reason, 'error')

  const texts = conn.updates.map(u => (u.update as any).content?.text).filter(Boolean)
  assert.ok(texts.some(text => text === 'Prompt failed: provider returned 500'))
})

test('PiAcpSession: re-emits startup info as the first chunk of the first prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'

  session.setStartupInfo(notice)
  session.sendStartupInfoIfPending()
  await new Promise(r => setTimeout(r, 0))

  const p = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: notice }
  })
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'agent_message_chunk')
  assert.deepEqual(conn.updates[1]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: notice }
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: cancel settles prompt when pi aborts without agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
  assert.equal(conn.updates.at(-1)?.update.sessionUpdate, 'session_info_update')
  assert.equal((conn.updates.at(-1)?.update as any)._meta.piAcp.running, false)
})

test('PiAcpSession: cancel disposes subprocess when pi abort hangs', async () => {
  class HungAbortProcess extends FakePiRpcProcess {
    disposeCount = 0
    private rejectPrompt: ((err: Error) => void) | null = null

    async prompt(message: string, attachments: unknown[] = []): Promise<void> {
      this.prompts.push({ message, attachments })
      return new Promise((_resolve, reject) => {
        this.rejectPrompt = reject
      })
    }

    async abort(): Promise<void> {
      this.abortCount += 1
      return new Promise(() => undefined)
    }

    dispose(): void {
      this.disposeCount += 1
      this.rejectPrompt?.(new Error('disposed'))
    }
  }

  const conn = new FakeAgentSideConnection()
  const proc = new HungAbortProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const promptResult = session.prompt('hello')
  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(await promptResult, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: starts queued prompt after current prompt failure', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    if (message === 'one') throw new Error('boom')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(await first, 'error')
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: willRetry agent_end keeps prompt pending until final agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let resolved = false
  const pending = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: true })

  await new Promise(r => setTimeout(r, 10))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  assert.equal(await pending, 'end_turn')
})

test('SessionManager: close settles running and queued prompt turns', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as FakePiRpcProcess & { dispose: () => void }
  let disposeCount = 0
  proc.dispose = () => {
    disposeCount += 1
  }

  const manager = new SessionManager()
  const session = manager.getOrCreate('s-close', {
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  manager.close('s-close')

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(disposeCount, 1)
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})
