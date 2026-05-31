import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PI_AMBIENT_AUTH_ENV_VARS, PI_AUTH_ENV_VARS } from '../../src/acp/logout.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

async function withTempAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const authEnvNames = [...PI_AUTH_ENV_VARS, ...PI_AMBIENT_AUTH_ENV_VARS]
  const previousAuthEnv = new Map<string, string | undefined>()
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-logout-'))
  process.env.PI_CODING_AGENT_DIR = dir
  for (const name of authEnvNames) {
    previousAuthEnv.set(name, process.env[name])
    delete process.env[name]
  }

  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    for (const [name, value] of previousAuthEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('PiAcpAgent: initialize advertises stored-auth logout capability', async () => {
  await withTempAgentDir(async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    })

    acpSchema.initializeResponse.parse(initialized)
    assert.deepEqual(initialized.agentCapabilities?.auth?._meta?.piAcp, {
      logoutSupported: true,
      nonClearableSources: []
    })
    assert.deepEqual(initialized.agentCapabilities?.auth?.logout?._meta?.piAcp, {
      clears: ['stored-auth-json'],
      doesNotClear: ['environment-variables', 'models-json-fallback', 'runtime-overrides'],
      nonClearableSources: []
    })
  })
})

test('PiAcpAgent: initialize omits logout when environment auth cannot be cleared', async () => {
  await withTempAgentDir(async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    })

    acpSchema.initializeResponse.parse(initialized)
    assert.equal(initialized.agentCapabilities?.auth?.logout, undefined)
    assert.deepEqual(initialized.agentCapabilities?.auth?._meta?.piAcp, {
      logoutSupported: false,
      nonClearableSources: ['environment:OPENAI_API_KEY']
    })
  })
})

test('PiAcpAgent: initialize omits logout when models.json auth cannot be cleared', async () => {
  await withTempAgentDir(async dir => {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          'local-proxy': {
            apiKey: 'literal-secret'
          }
        }
      })
    )
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    })

    acpSchema.initializeResponse.parse(initialized)
    assert.equal(initialized.agentCapabilities?.auth?.logout, undefined)
    assert.deepEqual(initialized.agentCapabilities?.auth?._meta?.piAcp, {
      logoutSupported: false,
      nonClearableSources: ['models-json-key:local-proxy']
    })
  })
})

test('PiAcpAgent: logout clears stored pi auth.json credentials', async () => {
  await withTempAgentDir(async dir => {
    const authPath = join(dir, 'auth.json')
    writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { kind: 'api_key', value: 'secret-1' },
        openai: { kind: 'api_key', value: 'secret-2' }
      })
    )

    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const response = await agent.unstable_logout({ _meta: null })

    acpSchema.logoutResponse.parse(response)
    assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')), {})
    assert.deepEqual(response._meta?.piAcp, {
      clears: ['stored-auth-json'],
      doesNotClear: ['environment-variables', 'models-json-fallback', 'runtime-overrides'],
      nonClearableSources: [],
      invalidAuthFileCleared: false,
      removedProviders: ['anthropic', 'openai']
    })
  })
})

test('PiAcpAgent: logout is idempotent and creates the auth file when absent', async () => {
  await withTempAgentDir(async dir => {
    const authPath = join(dir, 'auth.json')
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    const response = await agent.unstable_logout({ _meta: null })

    acpSchema.logoutResponse.parse(response)
    assert.equal(existsSync(authPath), true)
    assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')), {})
    assert.deepEqual(response._meta?.piAcp, {
      clears: ['stored-auth-json'],
      doesNotClear: ['environment-variables', 'models-json-fallback', 'runtime-overrides'],
      nonClearableSources: [],
      invalidAuthFileCleared: false,
      removedProviders: []
    })
  })
})

test('PiAcpAgent: logout clears malformed auth files without claiming providers', async () => {
  await withTempAgentDir(async dir => {
    mkdirSync(dir, { recursive: true })
    const authPath = join(dir, 'auth.json')
    writeFileSync(authPath, '{not-json')

    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const response = await agent.unstable_logout({ _meta: null })

    acpSchema.logoutResponse.parse(response)
    assert.deepEqual(JSON.parse(readFileSync(authPath, 'utf8')), {})
    assert.deepEqual(response._meta?.piAcp, {
      clears: ['stored-auth-json'],
      doesNotClear: ['environment-variables', 'models-json-fallback', 'runtime-overrides'],
      nonClearableSources: [],
      invalidAuthFileCleared: true,
      removedProviders: []
    })
  })
})

test('PiAcpAgent: logout rejects when non-clearable auth sources are configured', async () => {
  await withTempAgentDir(async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    await assert.rejects(
      () => agent.unstable_logout({ _meta: null }),
      (err: any) => {
        assert.equal(err?.code, -32602)
        assert.deepEqual(err?.data?.nonClearableSources, ['environment:OPENAI_API_KEY'])
        return true
      }
    )
  })
})
