import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientBridgeRpcHandler } from '../../src/acp/client-bridge.js'
import { PromptStopReasonOverrideStore } from '../../src/acp/client-stop-reasons.js'

test('client bridge stop reasons: records extension-owned prompt stop reason overrides', async () => {
  const store = new PromptStopReasonOverrideStore()
  const handler = createClientBridgeRpcHandler({
    conn: {} as any,
    clientCapabilities: {},
    getSessionId: () => 'sess-stop-reason',
    stopReasonOverrides: store
  })

  assert.deepEqual(
    await handler('prompt/set_stop_reason', {
      stopReason: 'max_turn_requests',
      source: 'test-extension'
    }),
    {}
  )
  assert.deepEqual(store.take('sess-stop-reason'), {
    stopReason: 'max_turn_requests',
    source: 'test-extension'
  })
  assert.equal(store.take('sess-stop-reason'), null)
})

test('client bridge stop reasons: validates override shape', async () => {
  const store = new PromptStopReasonOverrideStore()
  const handler = createClientBridgeRpcHandler({
    conn: {} as any,
    clientCapabilities: {},
    getSessionId: () => 'sess-stop-reason',
    stopReasonOverrides: store
  })

  await assert.rejects(async () => {
    await handler('prompt/set_stop_reason', { stopReason: 'error' })
  }, /stopReason must be max_turn_requests or refusal/)
  assert.equal(store.take('sess-stop-reason'), null)
})

test('client bridge stop reasons: records refusal history restore results', async () => {
  const store = new PromptStopReasonOverrideStore()
  const handler = createClientBridgeRpcHandler({
    conn: {} as any,
    clientCapabilities: {},
    getSessionId: () => 'sess-refusal',
    stopReasonOverrides: store
  })

  assert.deepEqual(
    await handler('prompt/refusal_history_restore_result', {
      sessionId: 'sess-refusal',
      restored: true,
      source: 'pi-acp-bridge',
      safeLeafId: 'assistant-1',
      userEntryId: 'user-2'
    }),
    {}
  )
  assert.deepEqual(store.takeRefusalHistoryRestore('sess-refusal'), {
    restored: true,
    source: 'pi-acp-bridge',
    sessionId: 'sess-refusal',
    safeLeafId: 'assistant-1',
    userEntryId: 'user-2'
  })
  assert.equal(store.takeRefusalHistoryRestore('sess-refusal'), null)
})
