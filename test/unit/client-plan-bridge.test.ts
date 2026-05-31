import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientBridgeRpcHandler } from '../../src/acp/client-bridge.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeAgentSideConnection {
  readonly updates: any[] = []

  async sessionUpdate(msg: any): Promise<void> {
    acpSchema.sessionNotification.parse(msg)
    this.updates.push(msg)
  }
}

test('client bridge plan: publishes complete ACP plan updates', async () => {
  const conn = new FakeAgentSideConnection()
  const handler = createClientBridgeRpcHandler({
    conn: conn as any,
    clientCapabilities: {},
    getSessionId: () => 'sess-plan',
    promptResourceStore: null
  })

  assert.deepEqual(
    await handler('plan/update', {
      entries: [
        { content: 'Inspect current adapter behavior', priority: 'high', status: 'completed' },
        { content: 'Wire extension plan service', priority: 'medium', status: 'in_progress', _meta: { owner: 'acp' } },
        { content: 'Add E2E coverage', priority: 'low', status: 'pending' }
      ]
    }),
    {}
  )

  assert.deepEqual(conn.updates, [
    {
      sessionId: 'sess-plan',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect current adapter behavior', priority: 'high', status: 'completed' },
          {
            content: 'Wire extension plan service',
            priority: 'medium',
            status: 'in_progress',
            _meta: { owner: 'acp' }
          },
          { content: 'Add E2E coverage', priority: 'low', status: 'pending' }
        ]
      }
    }
  ])
})

test('client bridge plan: validates plan entry shape before notifying client', async () => {
  const conn = new FakeAgentSideConnection()
  const handler = createClientBridgeRpcHandler({
    conn: conn as any,
    clientCapabilities: {},
    getSessionId: () => 'sess-plan',
    promptResourceStore: null
  })

  await assert.rejects(async () => {
    await handler('plan/update', {
      entries: [{ content: 'Invalid status', priority: 'high', status: 'blocked' }]
    })
  }, /status must be pending/)
  assert.deepEqual(conn.updates, [])
})
