import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits ACP diff content for edit tool when file changes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Start edit -> snapshot should be taken
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.txt' } })

  // Simulate file being edited by pi
  writeFileSync(filePath, 'after\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for edit completion')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')

  assert.equal(diff.path, filePath)
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
})

test('PiAcpSession: emits ACP diff content from adapter-managed client fs results', async () => {
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

  proc.emit({ type: 'tool_execution_start', toolCallId: 't-client-fs', toolName: 'edit', args: { path: 'client.txt' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-client-fs',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'ok' }],
      details: {
        path: '/client/workspace/client.txt',
        oldText: 'before\n',
        newText: 'after\n',
        source: 'acp-client-fs',
        tool: 'edit'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-client-fs' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for client fs edit completion')

  assert.deepEqual((end!.update as any).content, [
    {
      type: 'diff',
      path: '/client/workspace/client.txt',
      oldText: 'before\n',
      newText: 'after\n'
    },
    { type: 'content', content: { type: 'text', text: 'ok' } }
  ])
})

test('PiAcpSession: preserves nullable oldText for adapter-managed new-file diffs', async () => {
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
    type: 'tool_execution_start',
    toolCallId: 't-client-fs-new',
    toolName: 'write',
    args: { path: 'new.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-client-fs-new',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'created' }],
      details: {
        path: '/client/workspace/new.txt',
        oldText: null,
        newText: 'created\n',
        source: 'acp-client-fs',
        tool: 'write'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-client-fs-new' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for client fs write completion')

  assert.deepEqual((end!.update as any).content, [
    {
      type: 'diff',
      path: '/client/workspace/new.txt',
      oldText: null,
      newText: 'created\n'
    },
    { type: 'content', content: { type: 'text', text: 'created' } }
  ])
})

test('PiAcpSession: omits ACP diff content when local edit leaves file unchanged', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-unchanged-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'same.txt')
  writeFileSync(filePath, 'same\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't-local-unchanged',
    toolName: 'edit',
    args: { path: 'same.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-local-unchanged',
    isError: false,
    result: { content: [{ type: 'text', text: 'unchanged' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-local-unchanged' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for local unchanged edit')
  assert.deepEqual((end!.update as any).content, [{ type: 'content', content: { type: 'text', text: 'unchanged' } }])
})

test('PiAcpSession: omits adapter-managed diff content for unchanged writes', async () => {
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
    type: 'tool_execution_start',
    toolCallId: 't-client-fs-unchanged',
    toolName: 'write',
    args: { path: 'same.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-client-fs-unchanged',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'unchanged' }],
      details: {
        path: '/client/workspace/same.txt',
        oldText: 'same\n',
        newText: 'same\n',
        source: 'acp-client-fs',
        tool: 'write'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-client-fs-unchanged' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for client fs unchanged write')
  assert.deepEqual((end!.update as any).content, [{ type: 'content', content: { type: 'text', text: 'unchanged' } }])
})

test('PiAcpSession: omits adapter-managed diff content when path is not absolute', async () => {
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
    type: 'tool_execution_start',
    toolCallId: 't-client-fs-relative',
    toolName: 'edit',
    args: { path: 'relative.txt' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-client-fs-relative',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'changed' }],
      details: {
        path: 'relative.txt',
        oldText: 'before\n',
        newText: 'after\n',
        source: 'acp-client-fs',
        tool: 'edit'
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-client-fs-relative' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for client fs relative-path result')
  assert.deepEqual((end!.update as any).content, [{ type: 'content', content: { type: 'text', text: 'changed' } }])
})
