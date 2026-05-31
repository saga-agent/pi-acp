import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { createClientFsBridgeHandler } from '../../src/acp/client-fs.js'
import { createPromptResourceBridgeHandler, PromptResourceStore } from '../../src/acp/prompt-resources.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { createClientTerminalBridgeHandler } from '../../src/acp/client-terminal.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('ACP conformance: protocol path fields are absolute or rejected', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await assertRejectsWithData(
    () => agent.newSession({ cwd: 'relative', mcpServers: [], _meta: null } as any),
    /cwd must be an absolute path/
  )
  await assertRejectsWithData(
    () => agent.loadSession({ sessionId: 'missing', cwd: 'relative', mcpServers: [], _meta: null } as any),
    /cwd must be an absolute path/
  )
  await assertRejectsWithData(
    () => agent.resumeSession({ sessionId: 'missing', cwd: 'relative', mcpServers: [], _meta: null } as any),
    /cwd must be an absolute path/
  )
  await assertRejectsWithData(
    () => agent.listSessions({ cwd: 'relative', cursor: null, _meta: null } as any),
    /cwd must be an absolute path/
  )

  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-absolute-paths-'))
  const relativeToolPath = 'nested/file.txt'
  const absoluteToolPath = join(cwd, relativeToolPath)
  mkdirSync(join(cwd, 'nested'), { recursive: true })
  writeFileSync(absoluteToolPath, 'old\n', 'utf8')

  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's-absolute',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'relative-location',
    toolName: 'read',
    args: { path: relativeToolPath }
  })
  await new Promise(resolve => setImmediate(resolve))

  const locationPath = (conn.updates.at(-1)?.update as any)?.locations?.[0]?.path
  assert.equal(locationPath, absoluteToolPath)
  assert.equal(isAbsolute(locationPath), true)

  const fsBridge = createClientFsBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    getSessionId: () => 's-absolute'
  })
  await assert.rejects(async () => fsBridge('fs/read_text_file', { path: 'relative.txt' }), /path must be absolute/)
  await fsBridge('fs/read_text_file', { path: '/client/file.txt' })
  assert.deepEqual(conn.readTextFileRequests.at(-1), { sessionId: 's-absolute', path: '/client/file.txt' })

  const terminalBridge = createClientTerminalBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => 's-absolute'
  })
  await assert.rejects(
    async () => terminalBridge('terminal/create', { command: 'pwd', cwd: 'relative' }),
    /cwd must be absolute/
  )
  await terminalBridge('terminal/create', { command: 'pwd', cwd: '/client/workspace' })
  assert.deepEqual(conn.createTerminalRequests.at(-1), {
    sessionId: 's-absolute',
    command: 'pwd',
    cwd: '/client/workspace'
  })

  const promptResourceStore = new PromptResourceStore()
  const promptResource = {
    type: 'resource_link' as const,
    uri: 'file:///client/prompt-resource.txt',
    name: 'prompt-resource.txt',
    mimeType: 'text/plain'
  }
  promptResourceStore.setSessionResourceLinks('s-absolute', [promptResource])
  const promptResourceBridge = createPromptResourceBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true } },
    getSessionId: () => 's-absolute',
    promptResourceStore
  })
  await promptResourceBridge('resource/read_prompt_resource', { uri: promptResource.uri })
  assert.deepEqual(conn.readTextFileRequests.at(-1), {
    sessionId: 's-absolute',
    path: '/client/prompt-resource.txt'
  })
})

async function assertRejectsWithData(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(async () => {
    try {
      await fn()
    } catch (error) {
      assert.match(String((error as { data?: unknown }).data), pattern)
      throw error
    }
  })
}
