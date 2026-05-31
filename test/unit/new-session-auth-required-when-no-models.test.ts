import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create(_params: any) {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } },
    clientInfo: null,
    _meta: null
  })

  let threw = false
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  } catch (e: any) {
    threw = true
    assert.equal(e?.code, -32000)
    assert.match(String(e?.message), /Configure an API key or log in with an OAuth provider/i)
    assert.equal(e?.data?.authMethods?.[0]?.id, 'pi_terminal_login')
  }

  assert.equal(threw, true)
  assert.deepEqual(sessions.closeCalls, ['s1'])
})

test('PiAcpAgent: newSession omits terminal auth methods when unsupported by the client', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's-no-terminal-auth',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: null,
    _meta: null
  })

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => {
      assert.equal(e?.code, -32000)
      assert.deepEqual(e?.data?.authMethods, [])
      return true
    }
  )

  assert.deepEqual(sessions.closeCalls, ['s-no-terminal-auth'])
})
