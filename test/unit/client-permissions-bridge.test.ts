import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientBridgeRpcHandler } from '../../src/acp/client-bridge.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeAgentSideConnection {
  readonly permissionRequests: any[] = []
  nextPermissionResponse: any = { outcome: { outcome: 'cancelled' } }

  async requestPermission(params: any): Promise<any> {
    acpSchema.requestPermissionRequest.parse(params)
    this.permissionRequests.push(params)
    return typeof this.nextPermissionResponse === 'function'
      ? this.nextPermissionResponse(params)
      : this.nextPermissionResponse
  }
}

function createHandler(conn = new FakeAgentSideConnection()) {
  return {
    conn,
    handler: createClientBridgeRpcHandler({
      conn: conn as any,
      clientCapabilities: {},
      getSessionId: () => 'sess-tool-permission',
      promptResourceStore: null
    })
  }
}

test('client bridge permissions: requests ACP permission for pi tool calls', async () => {
  const { conn, handler } = createHandler()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } }

  const result = await handler('permission/request_tool_call', {
    toolCallId: 'bash-1',
    toolName: 'bash',
    input: { command: 'npm test' }
  })

  assert.deepEqual(result, { allowed: true, optionId: 'allow' })
  assert.equal(conn.permissionRequests.length, 1)
  assert.equal(conn.permissionRequests[0].sessionId, 'sess-tool-permission')
  assert.deepEqual(conn.permissionRequests[0].toolCall, {
    toolCallId: 'bash-1',
    title: 'bash',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm test' },
    _meta: {
      piAcp: {
        source: 'pi-extension-tool-call',
        toolName: 'bash'
      }
    }
  })
  assert.deepEqual(
    conn.permissionRequests[0].options.map((option: any) => [option.optionId, option.name, option.kind]),
    [
      ['allow', 'Allow once', 'allow_once'],
      ['allow_always', 'Always allow', 'allow_always'],
      ['reject', 'Reject', 'reject_once'],
      ['reject_always', 'Always reject', 'reject_always']
    ]
  )
})

test('client bridge permissions: caches allow_always and reject_always per stable tool input', async () => {
  const { conn, handler } = createHandler()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_always' } }

  assert.deepEqual(
    await handler('permission/request_tool_call', {
      toolCallId: 'edit-1',
      toolName: 'edit',
      input: { path: 'file.txt', edits: [{ oldText: 'a', newText: 'b' }] }
    }),
    { allowed: true, optionId: 'allow_always' }
  )
  assert.deepEqual(
    await handler('permission/request_tool_call', {
      toolCallId: 'edit-2',
      toolName: 'edit',
      input: { edits: [{ newText: 'b', oldText: 'a' }], path: 'file.txt' }
    }),
    { allowed: true, optionId: 'allow_always' }
  )
  assert.equal(conn.permissionRequests.length, 1)

  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'reject_always' } }
  assert.deepEqual(
    await handler('permission/request_tool_call', {
      toolCallId: 'bash-1',
      toolName: 'bash',
      input: { command: 'rm -rf tmp' }
    }),
    { allowed: false, optionId: 'reject_always', reason: 'Rejected by ACP client' }
  )
  assert.deepEqual(
    await handler('permission/request_tool_call', {
      toolCallId: 'bash-2',
      toolName: 'bash',
      input: { command: 'rm -rf tmp' }
    }),
    { allowed: false, optionId: 'reject_always', reason: 'Rejected by remembered ACP permission policy' }
  )
  assert.equal(conn.permissionRequests.length, 2)
})

test('client bridge permissions: maps cancelled permission outcome to rejection', async () => {
  const { handler } = createHandler()

  assert.deepEqual(
    await handler('permission/request_tool_call', {
      toolCallId: 'write-1',
      toolName: 'write',
      input: { path: 'file.txt', content: 'updated' }
    }),
    { allowed: false, reason: 'ACP permission request cancelled' }
  )
})
