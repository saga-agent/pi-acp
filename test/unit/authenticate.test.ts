import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

test('PiAcpAgent: authenticate accepts the advertised terminal method', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let readinessChecked = false
  ;(agent as any).assertAuthenticationReady = async () => {
    readinessChecked = true
  }
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } },
    clientInfo: null,
    _meta: null
  })

  const response = await agent.authenticate({ methodId: PI_SETUP_METHOD_ID, _meta: null })

  acpSchema.authenticateResponse.parse(response)
  assert.deepEqual(response, {})
  assert.equal(readinessChecked, true)
})

test('PiAcpAgent: authenticate returns AUTH_REQUIRED when terminal auth did not make models available', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } },
    clientInfo: null,
    _meta: null
  })
  ;(agent as any).assertAuthenticationReady = async () => {
    throw RequestError.authRequired(
      { authMethods: (agent as any).authMethods() },
      'Configure an API key or log in with an OAuth provider.'
    )
  }

  await assert.rejects(
    () => agent.authenticate({ methodId: PI_SETUP_METHOD_ID, _meta: null }),
    (err: any) => {
      assert.equal(err?.code, -32000)
      assert.equal(err?.data?.authMethods?.[0]?.id, PI_SETUP_METHOD_ID)
      return true
    }
  )
})

test('PiAcpAgent: authenticate rejects unknown method ids', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } },
    clientInfo: null,
    _meta: null
  })

  await assert.rejects(
    () => agent.authenticate({ methodId: 'unknown', _meta: null }),
    (err: any) => {
      assert.equal(err?.code, -32602)
      assert.match(String(err?.message), /Unknown authentication method/)
      assert.deepEqual(err?.data?.availableMethodIds, [PI_SETUP_METHOD_ID])
      return true
    }
  )
})

test('PiAcpAgent: initialize omits terminal auth when the client did not advertise support', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const response = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: null,
    _meta: null
  })

  assert.deepEqual(response.authMethods, [])
})
