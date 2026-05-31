import test from 'node:test'
import assert from 'node:assert/strict'

import { JsonlLineReader } from '../../src/pi-rpc/jsonl.js'

test('JsonlLineReader: buffers chunked lines and preserves split UTF-8 characters', () => {
  const lines: string[] = []
  const reader = new JsonlLineReader(line => lines.push(line))
  const payload = Buffer.from('{"text":"caf\u00e9"}\r\n{"ok":true}\n', 'utf8')
  const splitInsideUtf8 = payload.indexOf(0xc3) + 1

  reader.push(payload.subarray(0, splitInsideUtf8))
  assert.deepEqual(lines, [])

  reader.push(payload.subarray(splitInsideUtf8, payload.length - 1))
  assert.deepEqual(lines, ['{"text":"caf\u00e9"}'])

  reader.push(payload.subarray(payload.length - 1))
  assert.deepEqual(lines, ['{"text":"caf\u00e9"}', '{"ok":true}'])
})

test('JsonlLineReader: flushes a final unterminated line on end', () => {
  const lines: string[] = []
  const reader = new JsonlLineReader(line => lines.push(line))

  reader.push('partial')
  assert.deepEqual(lines, [])

  reader.end()
  assert.deepEqual(lines, ['partial'])
})
