import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePiAssistantText,
  normalizePiMessageText,
  piAssistantContentToAcpBlocks,
  piMessageContentToAcpBlocks
} from '../../src/acp/translate/pi-messages.js'

test('normalizePiMessageText: supports string', () => {
  assert.equal(normalizePiMessageText('hello'), 'hello')
})

test('normalizePiMessageText: joins text blocks', () => {
  assert.equal(
    normalizePiMessageText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'not_text', x: 1 }
    ]),
    'ab'
  )
})

test('normalizePiAssistantText: joins only text blocks', () => {
  assert.equal(
    normalizePiAssistantText([
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: '...' },
      { type: 'text', text: '!' }
    ]),
    'hi!'
  )
})

test('piMessageContentToAcpBlocks: preserves structured replay content blocks', () => {
  const blob = Buffer.from('abc', 'utf8').toString('base64')

  assert.deepEqual(
    piMessageContentToAcpBlocks([
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'file:///tmp/context.txt', name: 'context.txt', mimeType: 'text/plain' },
      { type: 'resource_link', uri: 'file:///tmp/fallback-name.txt' },
      { type: 'image', mimeType: 'image/png', data: 'aW1n', uri: 'file:///tmp/image.png' },
      { type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' },
      { type: 'resource', resource: { uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'embedded' } },
      { type: 'resource', resource: { uri: 'file:///tmp/a.bin', mimeType: 'application/octet-stream', blob } },
      { type: 'unknown', text: 'skip me' }
    ]),
    [
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'file:///tmp/context.txt', name: 'context.txt', mimeType: 'text/plain' },
      { type: 'resource_link', uri: 'file:///tmp/fallback-name.txt', name: 'fallback-name.txt' },
      { type: 'image', mimeType: 'image/png', data: 'aW1n', uri: 'file:///tmp/image.png' },
      { type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' },
      { type: 'resource', resource: { uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'embedded' } },
      { type: 'resource', resource: { uri: 'file:///tmp/a.bin', mimeType: 'application/octet-stream', blob } }
    ]
  )
})

test('piAssistantContentToAcpBlocks: preserves assistant resource links', () => {
  assert.deepEqual(
    piAssistantContentToAcpBlocks([
      { type: 'text', text: 'exported: ' },
      { type: 'resource_link', uri: 'file:///tmp/session.html', name: 'session.html', title: 'Session exported' },
      { type: 'thinking', text: 'skip' }
    ]),
    [
      { type: 'text', text: 'exported: ' },
      { type: 'resource_link', uri: 'file:///tmp/session.html', name: 'session.html', title: 'Session exported' }
    ]
  )
})
