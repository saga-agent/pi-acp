import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value

  return fn().finally(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

function installPromptSession(agent: PiAcpAgent, session: any): void {
  ;(agent as any).sessions = {
    get: (sessionId: string) => {
      assert.equal(sessionId, session.sessionId)
      return session
    }
  }
}

test('PiAcpAgent: accepts image prompt content because image is advertised', async () => {
  await withEnv('PI_ACP_ENABLE_EMBEDDED_CONTEXT', undefined, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const base64 = Buffer.from('image-bytes').toString('base64')
    const calls: Array<{ message: string; images: unknown[]; resourceLinks: unknown[] }> = []
    installPromptSession(agent, {
      sessionId: 'sess-image',
      prompt: async (message: string, images: unknown[], resourceLinks: unknown[]) => {
        calls.push({ message, images, resourceLinks })
        return 'end_turn'
      },
      wasCancelRequested: () => false
    })

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    } as any)
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.image, true)

    const response = await agent.prompt({
      sessionId: 'sess-image',
      prompt: [
        { type: 'text', text: 'inspect ' },
        { type: 'image', mimeType: 'image/png', data: base64 }
      ],
      _meta: null
    } as any)

    assert.deepEqual(response, { stopReason: 'end_turn' })
    assert.deepEqual(calls, [
      {
        message: 'inspect ',
        images: [{ type: 'image', mimeType: 'image/png', data: base64 }],
        resourceLinks: []
      }
    ])
  })
})

test('PiAcpAgent: rejects audio prompt content because audio is not advertised', async () => {
  await withEnv('PI_ACP_ENABLE_EMBEDDED_CONTEXT', undefined, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const session = {
      sessionId: 'sess-audio',
      prompt: async () => {
        throw new Error('unsupported audio must not reach pi prompt')
      }
    }
    installPromptSession(agent, session)

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    } as any)
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.audio, false)

    await assert.rejects(
      async () =>
        agent.prompt({
          sessionId: 'sess-audio',
          prompt: [{ type: 'audio', mimeType: 'audio/wav', data: Buffer.from('abc').toString('base64') }],
          _meta: null
        } as any),
      error => {
        assert.match(String((error as { data?: unknown }).data), /audio prompt content is not supported/)
        return true
      }
    )
  })
})

test('PiAcpAgent: accepts embedded resource prompt content only when advertised', async () => {
  const prompt = [
    {
      type: 'resource',
      resource: {
        uri: 'file:///tmp/context.txt',
        mimeType: 'text/plain',
        text: 'embedded context'
      }
    },
    {
      type: 'resource',
      resource: {
        uri: 'file:///tmp/context.bin',
        mimeType: 'application/octet-stream',
        blob: Buffer.from('blob context').toString('base64')
      }
    }
  ]

  await withEnv('PI_ACP_ENABLE_EMBEDDED_CONTEXT', undefined, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    installPromptSession(agent, {
      sessionId: 'sess-resource-disabled',
      prompt: async () => {
        throw new Error('unsupported embedded context must not reach pi prompt')
      }
    })

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    } as any)
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.embeddedContext, false)

    await assert.rejects(
      async () =>
        agent.prompt({
          sessionId: 'sess-resource-disabled',
          prompt,
          _meta: null
        } as any),
      error => {
        assert.match(String((error as { data?: unknown }).data), /embedded resource prompt content requires/)
        return true
      }
    )
  })

  await withEnv('PI_ACP_ENABLE_EMBEDDED_CONTEXT', 'true', async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const calls: Array<{ message: string; images: unknown[]; resourceLinks: unknown[] }> = []
    installPromptSession(agent, {
      sessionId: 'sess-resource-enabled',
      prompt: async (message: string, images: unknown[], resourceLinks: unknown[]) => {
        calls.push({ message, images, resourceLinks })
        return 'end_turn'
      },
      wasCancelRequested: () => false
    })

    const initialized = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: null,
      _meta: null
    } as any)
    assert.equal(initialized.agentCapabilities?.promptCapabilities?.embeddedContext, true)

    const response = await agent.prompt({
      sessionId: 'sess-resource-enabled',
      prompt,
      _meta: null
    } as any)

    assert.deepEqual(response, { stopReason: 'end_turn' })
    assert.deepEqual(calls, [
      {
        message:
          '\n[Embedded Context] file:///tmp/context.txt (text/plain)\nembedded context' +
          '\n[Embedded Context] file:///tmp/context.bin (application/octet-stream, 12 bytes)',
        images: [],
        resourceLinks: []
      }
    ])
  })
})
