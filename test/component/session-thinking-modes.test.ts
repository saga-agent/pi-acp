import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    acpSchema.sessionNotification.parse(msg)
    this.updates.push(msg)
  }
}

function installFakeSession(agent: PiAcpAgent, sessionId: string, proc: any) {
  ;(agent as any).sessions = {
    get: (id: string) => {
      assert.equal(id, sessionId)
      return { sessionId, proc }
    }
  }
}

test('PiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits current_mode_update', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  const calls: any[] = []
  const state = {
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  }

  const proc = {
    getAvailableModels: async () => ({ models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }] }),
    getState: async () => state,
    setThinkingLevel: async (level: string) => {
      calls.push(['setThinkingLevel', level])
      state.thinkingLevel = level
    }
  }

  installFakeSession(agent, 'sess-mode', proc)

  const response = await agent.setSessionMode({ sessionId: 'sess-mode', modeId: 'high', _meta: null } as any)
  acpSchema.setSessionModeResponse.parse(response ?? {})
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(calls, [['setThinkingLevel', 'high']])

  const currentModeUpdate = conn.updates.find(update => update.update?.sessionUpdate === 'current_mode_update')
  assert.ok(currentModeUpdate)
  assert.equal(currentModeUpdate.update.currentModeId, 'high')
})

test('PiAcpAgent: setSessionMode rejects unknown mode IDs', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  installFakeSession(agent, 'sess-mode', {
    setThinkingLevel: async () => {
      throw new Error('invalid mode must not reach pi')
    }
  })

  await assert.rejects(
    () => agent.setSessionMode({ sessionId: 'sess-mode', modeId: 'invalid', _meta: null } as any),
    error => {
      assert.match(String((error as { data?: unknown }).data), /Unknown modeId: invalid/)
      return true
    }
  )
})

test('PiAcpAgent: setSessionConfigOption maps model selector to pi setModel', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  const calls: any[] = []
  const state = {
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  }

  const proc = {
    getAvailableModels: async () => ({
      models: [
        { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
        { provider: 'openai', id: 'gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' }
      ]
    }),
    getState: async () => state,
    setModel: async (provider: string, modelId: string) => {
      calls.push(['setModel', provider, modelId])
      state.model = { provider, id: modelId }
    }
  }

  installFakeSession(agent, 'sess-config', proc)

  const response = await agent.setSessionConfigOption({
    sessionId: 'sess-config',
    configId: 'model',
    value: 'openai/gpt-5.3-codex-spark',
    _meta: null
  } as any)
  acpSchema.setSessionConfigOptionResponse.parse(response)

  assert.deepEqual(calls, [['setModel', 'openai', 'gpt-5.3-codex-spark']])

  const modelOption = response.configOptions.find(option => option.id === 'model')
  assert.equal(modelOption?.type, 'select')
  assert.equal((modelOption as any)?.currentValue, 'openai/gpt-5.3-codex-spark')
  assert.ok((modelOption as any)?.options.some((option: any) => option.value === 'openai/gpt-5.3-codex-spark'))

  const thoughtOption = response.configOptions.find(option => option.id === 'thought_level')
  assert.equal((thoughtOption as any)?.currentValue, 'medium')
})

test('PiAcpAgent: unstable_setSessionModel aliases model selection and emits config update', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  const calls: any[] = []
  const state = {
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  }

  const proc = {
    getAvailableModels: async () => ({
      models: [
        { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
        { provider: 'openai', id: 'gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' }
      ]
    }),
    getState: async () => state,
    setModel: async (provider: string, modelId: string) => {
      calls.push(['setModel', provider, modelId])
      state.model = { provider, id: modelId }
    }
  }

  installFakeSession(agent, 'sess-model', proc)

  const response = await agent.unstable_setSessionModel({
    sessionId: 'sess-model',
    modelId: 'openai/gpt-5.3-codex-spark',
    _meta: null
  } as any)
  acpSchema.setSessionModelResponse.parse(response ?? {})

  assert.deepEqual(calls, [['setModel', 'openai', 'gpt-5.3-codex-spark']])

  const configUpdate = conn.updates.find(update => update.update?.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)

  const modelOption = configUpdate.update.configOptions.find((option: any) => option.id === 'model')
  assert.equal(modelOption.currentValue, 'openai/gpt-5.3-codex-spark')
  assert.ok(configUpdate.update.configOptions.some((option: any) => option.id === 'thought_level'))
})

test('PiAcpAgent: setSessionConfigOption maps thought_level selector to pi setThinkingLevel', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  const calls: any[] = []
  const state = {
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  }

  const proc = {
    getAvailableModels: async () => ({ models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }] }),
    getState: async () => state,
    setThinkingLevel: async (level: string) => {
      calls.push(['setThinkingLevel', level])
      state.thinkingLevel = level
    }
  }

  installFakeSession(agent, 'sess-config', proc)

  const response = await agent.setSessionConfigOption({
    sessionId: 'sess-config',
    configId: 'thought_level',
    value: 'high',
    _meta: null
  } as any)
  acpSchema.setSessionConfigOptionResponse.parse(response)

  assert.deepEqual(calls, [['setThinkingLevel', 'high']])

  const thoughtOption = response.configOptions.find(option => option.id === 'thought_level')
  assert.equal((thoughtOption as any)?.currentValue, 'high')
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'current_mode_update'))
})

test('PiAcpAgent: legacy setSessionMode also emits complete config_option_update', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  const state = {
    model: { provider: 'openai', id: 'gpt-5' },
    thinkingLevel: 'medium'
  }

  const proc = {
    getAvailableModels: async () => ({ models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }] }),
    getState: async () => state,
    setThinkingLevel: async (level: string) => {
      state.thinkingLevel = level
    }
  }

  installFakeSession(agent, 'sess-config', proc)

  const response = await agent.setSessionMode({ sessionId: 'sess-config', modeId: 'low', _meta: null } as any)
  acpSchema.setSessionModeResponse.parse(response ?? {})
  await new Promise(resolve => setImmediate(resolve))

  const configUpdate = conn.updates.find(update => update.update?.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)

  const thoughtOption = configUpdate.update.configOptions.find((option: any) => option.id === 'thought_level')
  assert.equal(thoughtOption.currentValue, 'low')
  assert.ok(configUpdate.update.configOptions.some((option: any) => option.id === 'model'))
})
