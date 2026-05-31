import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

class CapturingSessions {
  createParams: any = null

  async create(params: any) {
    this.createParams = params
    return {
      sessionId: 'sess-bridge',
      cwd: params.cwd,
      proc: {
        getState: async () => ({
          sessionId: 'sess-bridge',
          thinkingLevel: 'medium',
          model: { provider: 'openai', id: 'gpt-5' }
        }),
        getAvailableModels: async () => ({
          models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }]
        }),
        getCommands: async () => ({ commands: [] })
      },
      setStartupInfo: () => {
        // noop
      },
      sendStartupInfoIfPending: () => {
        // noop
      }
    }
  }
}

test('PiAcpAgent: session/new passes ACP setup into the bridge extension spawn config', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new CapturingSessions()
  ;(agent as any).sessions = sessions

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true
    },
    clientInfo: null,
    _meta: null
  } as any)

  const mcpServers = [{ name: 'stdio-test', command: '/bin/echo', args: ['ok'], env: {} }]
  const response = await agent.newSession({
    cwd: process.cwd(),
    mcpServers,
    _meta: null
  } as any)

  acpSchema.newSessionResponse.parse(response)
  assert.equal(response.sessionId, 'sess-bridge')
  assert.equal(Object.prototype.hasOwnProperty.call(response as any, 'models'), false)
  assert.equal((response as any)._meta?.piAcp?.models?.currentModelId, 'openai/gpt-5')
  assert.equal(sessions.createParams.cwd, process.cwd())
  assert.deepEqual(sessions.createParams.mcpServers, mcpServers)

  const bridgeSetup = sessions.createParams.bridgeSetup
  assert.equal(bridgeSetup.version, 1)
  assert.equal(bridgeSetup.lifecycle, 'new')
  assert.equal(bridgeSetup.cwd, process.cwd())
  assert.equal(bridgeSetup.sessionId, null)
  assert.deepEqual(bridgeSetup.mcpServers, mcpServers)
  assert.deepEqual(bridgeSetup.clientCapabilities, {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true
  })
  assert.deepEqual(bridgeSetup.toolCallPermissions, {
    enabled: true,
    toolNames: ['bash', 'acp_terminal_execute', 'write', 'edit', 'delete', 'move', 'acp_write_text_file']
  })
  assert.match(bridgeSetup.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})
