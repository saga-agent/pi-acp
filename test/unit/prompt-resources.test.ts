import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createPromptResourceBridgeHandler, PromptResourceStore } from '../../src/acp/prompt-resources.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('prompt resource bridge: reads text and binary data URI resource links without client fs', async () => {
  const conn = new FakeAgentSideConnection()
  const store = new PromptResourceStore()
  const textUri = `data:text/plain;base64,${Buffer.from('hello data', 'utf8').toString('base64')}`
  const binaryUri = `data:application/octet-stream;base64,${Buffer.from([0, 1, 2]).toString('base64')}`

  store.setSessionResourceLinks('s1', [
    { type: 'resource_link', uri: textUri, name: 'note.txt', mimeType: 'text/plain' },
    { type: 'resource_link', uri: binaryUri, name: 'blob.bin', mimeType: 'application/octet-stream' }
  ])

  const bridge = createPromptResourceBridgeHandler({
    conn: asAgentConn(conn),
    clientCapabilities: {},
    getSessionId: () => 's1',
    promptResourceStore: store
  })

  assert.deepEqual(await bridge('resource/read_prompt_resource', { uri: textUri }), {
    contents: [{ uri: textUri, mimeType: 'text/plain', text: 'hello data' }]
  })
  assert.deepEqual(await bridge('resource/read_prompt_resource', { uri: binaryUri }), {
    contents: [
      { uri: binaryUri, mimeType: 'application/octet-stream', blob: Buffer.from([0, 1, 2]).toString('base64') }
    ]
  })
  assert.deepEqual(conn.readTextFileRequests, [])
})

test('prompt resource bridge: reads http resource links with response content type', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end('{"ok":true}')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  try {
    const conn = new FakeAgentSideConnection()
    const store = new PromptResourceStore()
    const address = server.address() as AddressInfo
    const uri = `http://127.0.0.1:${address.port}/resource.json`
    store.setSessionResourceLinks('s1', [{ type: 'resource_link', uri, name: 'resource.json' }])

    const bridge = createPromptResourceBridgeHandler({
      conn: asAgentConn(conn),
      clientCapabilities: {},
      getSessionId: () => 's1',
      promptResourceStore: store
    })

    assert.deepEqual(await bridge('resource/read_prompt_resource', { uri }), {
      contents: [{ uri, mimeType: 'application/json', text: '{"ok":true}' }]
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
