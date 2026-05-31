import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeAgentSideConnection {
  readonly permissionRequests: any[] = []
  readonly updates: any[] = []
  nextPermissionResponse: any = { outcome: { outcome: 'cancelled' } }

  async sessionUpdate(msg: any): Promise<void> {
    acpSchema.sessionNotification.parse(msg)
    this.updates.push(msg)
  }

  async requestPermission(params: any): Promise<any> {
    acpSchema.requestPermissionRequest.parse(params)
    this.permissionRequests.push(params)
    return typeof this.nextPermissionResponse === 'function'
      ? this.nextPermissionResponse(params)
      : this.nextPermissionResponse
  }
}

class FakePiRpcProcess {
  private handlers: Array<(ev: any) => void> = []
  readonly extensionResponses: any[] = []
  abortCount = 0

  onEvent(handler: (ev: any) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: any): void {
    for (const handler of this.handlers) handler(ev)
  }

  sendExtensionUiResponse(response: any): void {
    this.extensionResponses.push(response)
  }

  async prompt(): Promise<void> {
    // noop
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }
}

function createSession(conn = new FakeAgentSideConnection(), proc = new FakePiRpcProcess()) {
  const session = new PiAcpSession({
    sessionId: 'sess-perm',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: conn as any
  })
  return { session, conn, proc }
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('PiAcpSession: bridges extension select UI through ACP permission request', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'option-1' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-select',
    method: 'select',
    title: 'Pick target',
    options: ['Alpha', 'Beta']
  })
  await nextTick()

  assert.equal(conn.permissionRequests.length, 1)
  assert.equal(conn.permissionRequests[0].sessionId, 'sess-perm')
  assert.equal(conn.permissionRequests[0].toolCall.toolCallId, 'extension-ui:ui-select')
  assert.equal(conn.permissionRequests[0].toolCall.title, 'Pick target')
  assert.deepEqual(
    conn.permissionRequests[0].options.map((option: any) => [option.optionId, option.name, option.kind]),
    [
      ['option-0', 'Alpha', 'allow_once'],
      ['option-1', 'Beta', 'allow_once'],
      ['cancel', 'Cancel', 'reject_once']
    ]
  )
  assert.deepEqual(proc.extensionResponses, [{ id: 'ui-select', value: 'Beta' }])
})

test('PiAcpSession: bridges extension confirm UI through ACP permission request', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'reject' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-confirm',
    method: 'confirm',
    title: 'Run action',
    message: 'Proceed?'
  })
  await nextTick()

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(
    conn.permissionRequests[0].options.map((option: any) => [option.optionId, option.name, option.kind]),
    [
      ['confirm', 'Confirm', 'allow_once'],
      ['confirm_always', 'Always confirm', 'allow_always'],
      ['reject', 'Reject', 'reject_once'],
      ['reject_always', 'Always reject', 'reject_always']
    ]
  )
  assert.deepEqual(proc.extensionResponses, [{ id: 'ui-confirm', confirmed: false }])
})

test('PiAcpSession: remembers allow_always for matching extension confirm UI', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'confirm_always' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-confirm-1',
    method: 'confirm',
    title: 'Run action',
    message: 'Proceed?'
  })
  await nextTick()

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-confirm-2',
    method: 'confirm',
    title: 'Run action',
    message: 'Proceed?'
  })
  await nextTick()

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionResponses, [
    { id: 'ui-confirm-1', confirmed: true },
    { id: 'ui-confirm-2', confirmed: true }
  ])
})

test('PiAcpSession: remembers reject_always for matching extension confirm UI', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'reject_always' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-reject-1',
    method: 'confirm',
    title: 'Delete cache',
    message: 'Proceed?'
  })
  await nextTick()

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-reject-2',
    method: 'confirm',
    title: 'Delete cache',
    message: 'Proceed?'
  })
  await nextTick()

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionResponses, [
    { id: 'ui-reject-1', confirmed: false },
    { id: 'ui-reject-2', confirmed: false }
  ])
})

test('PiAcpSession: surfaces extension notify UI as an ACP message chunk', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-notify',
    method: 'notify',
    message: 'MCP server "demo" failed',
    notifyType: 'error'
  })
  await nextTick()

  assert.deepEqual(conn.updates, [
    {
      sessionId: 'sess-perm',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Extension error: MCP server "demo" failed' }
      }
    }
  ])
  assert.deepEqual(proc.extensionResponses, [])
})

test('PiAcpSession: cancel responds to pending extension UI permission as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const { session } = createSession(conn, proc)

  let resolvePermission!: (value: any) => void
  conn.nextPermissionResponse = () =>
    new Promise(resolve => {
      resolvePermission = resolve
    })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-pending',
    method: 'confirm',
    title: 'Run action',
    message: 'Proceed?'
  })
  await nextTick()

  assert.equal(conn.permissionRequests.length, 1)

  await session.cancel()
  resolvePermission({ outcome: { outcome: 'selected', optionId: 'confirm' } })
  await nextTick()

  assert.equal(proc.abortCount, 1)
  assert.deepEqual(proc.extensionResponses, [{ id: 'ui-pending', cancelled: true }])
})
