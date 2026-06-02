import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function assertModelsAreMetaOnly(response: any): void {
  assert.equal(Object.prototype.hasOwnProperty.call(response, 'models'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(response?._meta?.piAcp ?? {}, 'models'), true)
}

test('PiAcpAgent: listSessions lists pi sessions and loadSession replays history', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    let loadResolved = false
    const originalSessionUpdate = conn.sessionUpdate.bind(conn)
    conn.sessionUpdate = async msg => {
      const update = (msg as any).update
      if (
        update?.sessionUpdate === 'user_message_chunk' ||
        update?.sessionUpdate === 'agent_message_chunk' ||
        update?.sessionUpdate === 'tool_call' ||
        update?.sessionUpdate === 'tool_call_update'
      ) {
        assert.equal(loadResolved, false, 'session/load replay updates must be emitted before loadSession resolves')
      }
      return originalSessionUpdate(msg)
    }
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
      clientInfo: null,
      _meta: null
    } as any)

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    acpSchema.listSessionsResponse.parse(listed)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
    const originalSpawn = PiRpcProcess.spawn

    const mcpServers = [{ name: 'load-mcp', command: '/bin/echo', args: ['ok'], env: [] }]
    let capturedSpawnParams: any = null

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      capturedSpawnParams = params
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Hello' },
                {
                  type: 'resource_link',
                  uri: 'file:///tmp/project/context.txt',
                  name: 'context.txt',
                  mimeType: 'text/plain'
                },
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: Buffer.from('png', 'utf8').toString('base64'),
                  uri: 'file:///tmp/project/image.png'
                },
                {
                  type: 'resource',
                  resource: {
                    uri: 'file:///tmp/project/embedded.txt',
                    mimeType: 'text/plain',
                    text: 'embedded context'
                  }
                }
              ]
            },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hi there!' },
                {
                  type: 'resource_link',
                  uri: 'file:///tmp/project/session.html',
                  name: 'session.html',
                  title: 'Session export'
                }
              ]
            }
          ]
        }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      const loaded = await agent.loadSession({
        sessionId: 'sess-1',
        cwd: '/tmp/project',
        mcpServers,
        _meta: null
      } as any)
      loadResolved = true
      acpSchema.loadSessionResponse.parse(loaded)
      assertModelsAreMetaOnly(loaded)
      assert.equal((loaded as any)._meta.piAcp.models, null)
      assert.ok((loaded as any).configOptions.some((option: any) => option.id === 'thought_level'))
      assert.equal(capturedSpawnParams.bridgeSetup.lifecycle, 'load')
      assert.equal(capturedSpawnParams.bridgeSetup.cwd, '/tmp/project')
      assert.equal(capturedSpawnParams.bridgeSetup.sessionId, 'sess-1')
      assert.deepEqual(capturedSpawnParams.bridgeSetup.mcpServers, mcpServers)
      assert.deepEqual(capturedSpawnParams.bridgeSetup.clientCapabilities, { fs: { readTextFile: true } })

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))

      const replayedContent = conn.updates
        .map(u => (u as any).update)
        .filter(u => u?.sessionUpdate === 'user_message_chunk' || u?.sessionUpdate === 'agent_message_chunk')
        .map(u => ({ kind: u.sessionUpdate, content: u.content }))

      assert.deepEqual(replayedContent, [
        { kind: 'user_message_chunk', content: { type: 'text', text: 'Hello' } },
        {
          kind: 'user_message_chunk',
          content: {
            type: 'resource_link',
            uri: 'file:///tmp/project/context.txt',
            name: 'context.txt',
            mimeType: 'text/plain'
          }
        },
        {
          kind: 'user_message_chunk',
          content: {
            type: 'image',
            mimeType: 'image/png',
            data: Buffer.from('png', 'utf8').toString('base64'),
            uri: 'file:///tmp/project/image.png'
          }
        },
        {
          kind: 'user_message_chunk',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/project/embedded.txt',
              mimeType: 'text/plain',
              text: 'embedded context'
            }
          }
        },
        { kind: 'agent_message_chunk', content: { type: 'text', text: 'Hi there!' } },
        {
          kind: 'agent_message_chunk',
          content: {
            type: 'resource_link',
            uri: 'file:///tmp/project/session.html',
            name: 'session.html',
            title: 'Session export'
          }
        }
      ])
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: listSessions rejects invalid cwd and cursor', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await assert.rejects(
    () => agent.listSessions({ cwd: 'relative/path', cursor: null, _meta: null } as any),
    /Invalid params/
  )

  await assert.rejects(
    () => agent.listSessions({ cwd: null, cursor: 'not-a-cursor', _meta: null } as any),
    /Invalid params/
  )
})

test('PiAcpAgent: listSessions paginates with opaque cursors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })

  for (let i = 0; i < 55; i += 1) {
    const hex = i.toString(16).padStart(32, '0')
    const sessionFile = join(sessionsDir, `0000_${hex}.jsonl`)
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: `sess-page-${i}`,
        timestamp: `2026-02-11T00:${String(i).padStart(2, '0')}:00.000Z`,
        cwd: '/tmp/project'
      }) + '\n',
      { encoding: 'utf8' }
    )
  }

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    const first = await agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)
    acpSchema.listSessionsResponse.parse(first)
    assert.equal(first.sessions.length, 50)
    assert.ok(first.nextCursor)
    assert.doesNotMatch(first.nextCursor, /^\d+$/)

    const second = await agent.listSessions({ cwd: '/tmp/project', cursor: first.nextCursor, _meta: null } as any)
    acpSchema.listSessionsResponse.parse(second)
    assert.equal(second.sessions.length, 5)
    assert.equal(second.nextCursor, null)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: resumeSession attaches without replaying history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jsonl')

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-resume',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Do not replay me' }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const originalSpawn = PiRpcProcess.spawn

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { terminal: true },
      clientInfo: null,
      _meta: null
    } as any)

    const mcpServers = [{ name: 'resume-mcp', command: '/bin/echo', args: ['ok'], env: [] }]
    let capturedSpawnParams: any = null

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      capturedSpawnParams = params
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => {
          throw new Error('resumeSession must not replay messages')
        },
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' }),
        getCommands: async () => ({ commands: [] })
      } as any
    }

    const resumed = await agent.resumeSession({
      sessionId: 'sess-resume',
      cwd: '/tmp/project',
      mcpServers,
      _meta: null
    } as any)
    acpSchema.resumeSessionResponse.parse(resumed)
    assertModelsAreMetaOnly(resumed)
    assert.equal((resumed as any)._meta.piAcp.models, null)
    assert.equal(capturedSpawnParams.bridgeSetup.lifecycle, 'resume')
    assert.equal(capturedSpawnParams.bridgeSetup.cwd, '/tmp/project')
    assert.equal(capturedSpawnParams.bridgeSetup.sessionId, 'sess-resume')
    assert.deepEqual(capturedSpawnParams.bridgeSetup.mcpServers, mcpServers)
    assert.deepEqual(capturedSpawnParams.bridgeSetup.clientCapabilities, { terminal: true })

    assert.ok(resumed)
    assert.ok((resumed as any).configOptions.some((option: any) => option.id === 'thought_level'))

    await new Promise(r => setTimeout(r, 0))

    const replayed = conn.updates
      .map(u => (u as any).update)
      .filter(u => u?.sessionUpdate === 'user_message_chunk' || u?.sessionUpdate === 'agent_message_chunk')

    assert.deepEqual(replayed, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: resumeSession reuses active sessions only when cwd matches', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const calls: string[] = []

  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => {
      assert.equal(sessionId, 'sess-active')
      return {
        sessionId,
        cwd: '/tmp/project',
        proc: {
          getAvailableModels: async () => {
            calls.push('getAvailableModels')
            return { models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }] }
          },
          getState: async () => {
            calls.push('getState')
            return { model: { provider: 'openai', id: 'gpt-5' }, thinkingLevel: 'medium' }
          }
        }
      }
    }
  }

  const resumed = await agent.resumeSession({
    sessionId: 'sess-active',
    cwd: '/tmp/project',
    mcpServers: [],
    _meta: null
  } as any)
  acpSchema.resumeSessionResponse.parse(resumed)
  assertModelsAreMetaOnly(resumed)
  assert.deepEqual(calls, ['getAvailableModels', 'getState', 'getState'])

  await assert.rejects(
    async () =>
      agent.resumeSession({
        sessionId: 'sess-active',
        cwd: '/tmp/other-project',
        mcpServers: [],
        _meta: null
      } as any),
    error => {
      assert.match(String((error as { data?: unknown }).data), /does not match active session cwd/)
      return true
    }
  )
  assert.deepEqual(calls, ['getAvailableModels', 'getState', 'getState'])
})

test('PiAcpAgent: closeSession cancels and disposes the active session', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const calls: string[] = []
  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => {
      assert.equal(sessionId, 'sess-close')
      return {
        cancel: async () => {
          calls.push('cancel')
        }
      }
    },
    close: (sessionId: string) => {
      assert.equal(sessionId, 'sess-close')
      calls.push('close')
    }
  }

  const closed = await agent.closeSession({ sessionId: 'sess-close', _meta: null } as any)
  acpSchema.closeSessionResponse.parse(closed)

  assert.deepEqual(calls, ['cancel', 'close'])
})

test('PiAcpAgent: closeSession disposes the active session when cancel hangs', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const calls: string[] = []
  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => {
      assert.equal(sessionId, 'sess-close-hung-cancel')
      return {
        cancel: async () => {
          calls.push('cancel')
          await new Promise(() => {})
        }
      }
    },
    close: (sessionId: string) => {
      assert.equal(sessionId, 'sess-close-hung-cancel')
      calls.push('close')
    }
  }

  const started = Date.now()
  const closed = await agent.closeSession({ sessionId: 'sess-close-hung-cancel', _meta: null } as any)
  acpSchema.closeSessionResponse.parse(closed)

  assert.deepEqual(calls, ['cancel', 'close'])
  assert.equal(Date.now() - started < 2_000, true)
})
