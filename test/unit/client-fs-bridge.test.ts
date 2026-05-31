import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientFsBridgeHandler, supportsAnyClientFs } from '../../src/acp/client-fs.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('client fs bridge: delegates read and write requests to ACP client methods', async () => {
  const conn = new FakeAgentSideConnection()
  conn.readTextFileContent = 'client buffer'
  const handler = createClientFsBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    getSessionId: () => 'sess-fs'
  })

  const read = await handler('fs/read_text_file', { path: '/tmp/file.txt', line: 2, limit: 3 })
  assert.deepEqual(read, { content: 'client buffer' })
  assert.deepEqual(conn.readTextFileRequests, [{ sessionId: 'sess-fs', path: '/tmp/file.txt', line: 2, limit: 3 }])

  const write = await handler('fs/write_text_file', { path: '/tmp/file.txt', content: 'updated' })
  assert.deepEqual(write, {})
  assert.deepEqual(conn.writeTextFileRequests, [{ sessionId: 'sess-fs', path: '/tmp/file.txt', content: 'updated' }])
})

test('client fs bridge: validates capabilities, session id, and absolute paths', async () => {
  const conn = new FakeAgentSideConnection()

  assert.equal(supportsAnyClientFs(null), false)
  assert.equal(supportsAnyClientFs({ fs: { readTextFile: true } }), true)

  const missingSession = createClientFsBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true } },
    getSessionId: () => null
  })
  await assert.rejects(async () => missingSession('fs/read_text_file', { path: '/tmp/file.txt' }), /session id/)

  const unsupported = createClientFsBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    getSessionId: () => 'sess-fs'
  })
  await assert.rejects(async () => unsupported('fs/read_text_file', { path: '/tmp/file.txt' }), /did not advertise/)

  const handler = createClientFsBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: { fs: { readTextFile: true } },
    getSessionId: () => 'sess-fs'
  })
  await assert.rejects(async () => handler('fs/read_text_file', { path: 'relative.txt' }), /path must be absolute/)
  await assert.rejects(async () => handler('fs/read_text_file', { path: '/tmp/file.txt', limit: -1 }), /limit/)
  await assert.rejects(async () => handler('unknown', {}), /Unsupported/)
})
