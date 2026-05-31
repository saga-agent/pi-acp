import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientTerminalBridgeHandler, supportsClientTerminal } from '../../src/acp/client-terminal.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('client terminal bridge: delegates terminal lifecycle requests to ACP client handles', async () => {
  const conn = new FakeAgentSideConnection()
  conn.terminalId = 'term-123'
  conn.terminalOutput = {
    output: 'terminal output',
    truncated: false,
    exitStatus: { exitCode: 0, signal: null }
  }
  conn.terminalExitStatus = { exitCode: 0, signal: null }

  const handler = createClientTerminalBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => 'sess-terminal'
  })

  const created = await handler('terminal/create', {
    command: 'npm',
    args: ['test'],
    env: [{ name: 'NODE_ENV', value: 'test' }],
    cwd: '/tmp/project',
    outputByteLimit: 1024
  })
  assert.deepEqual(created, { terminalId: 'term-123' })
  assert.deepEqual(conn.createTerminalRequests, [
    {
      sessionId: 'sess-terminal',
      command: 'npm',
      args: ['test'],
      env: [{ name: 'NODE_ENV', value: 'test' }],
      cwd: '/tmp/project',
      outputByteLimit: 1024
    }
  ])

  assert.deepEqual(await handler('terminal/output', { terminalId: 'term-123' }), conn.terminalOutput)
  assert.deepEqual(await handler('terminal/wait_for_exit', { terminalId: 'term-123' }), conn.terminalExitStatus)
  assert.deepEqual(await handler('terminal/kill', { terminalId: 'term-123' }), {})
  assert.equal(conn.terminalKillCount, 1)
  assert.deepEqual(await handler('terminal/release', { terminalId: 'term-123' }), {})
  assert.equal(conn.terminalReleaseCount, 1)

  await assert.rejects(async () => handler('terminal/output', { terminalId: 'term-123' }), /Unknown ACP terminal id/)
})

test('client terminal bridge: validates capabilities, session id, and request shape', async () => {
  const conn = new FakeAgentSideConnection()

  assert.equal(supportsClientTerminal(null), false)
  assert.equal(supportsClientTerminal({ terminal: true }), true)

  const missingSession = createClientTerminalBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => null
  })
  await assert.rejects(async () => missingSession('terminal/create', { command: 'pwd' }), /session id/)

  const unsupported = createClientTerminalBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: false },
    getSessionId: () => 'sess-terminal'
  })
  await assert.rejects(async () => unsupported('terminal/create', { command: 'pwd' }), /did not advertise/)

  const handler = createClientTerminalBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { terminal: true },
    getSessionId: () => 'sess-terminal'
  })
  await assert.rejects(
    async () => handler('terminal/create', { command: 'pwd', cwd: 'relative' }),
    /cwd must be absolute/
  )
  await assert.rejects(async () => handler('terminal/create', { command: 'pwd', args: [1] }), /args/)
  await assert.rejects(
    async () => handler('terminal/create', { command: 'pwd', outputByteLimit: -1 }),
    /outputByteLimit/
  )
  await assert.rejects(async () => handler('terminal/output', { terminalId: 'missing' }), /Unknown ACP terminal id/)
  await assert.rejects(async () => handler('unknown', {}), /Unsupported/)
})
