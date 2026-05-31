import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will run bash.' },
              { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hello' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'grep',
            content: [{ type: 'text', text: 'matched line' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_3',
            toolName: 'web_fetch',
            content: [{ type: 'text', text: 'fetched page' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_4',
            toolName: 'reasoning',
            content: [{ type: 'text', text: 'plan created' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_1')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'bash')
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.status, 'completed')
    assert.deepEqual(toolCall.rawInput, { command: 'echo hello' })
    assert.equal(updates.filter(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_1').length, 1)

    const searchToolCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_2')
    assert.ok(searchToolCall)
    assert.equal(searchToolCall.title, 'grep')
    assert.equal(searchToolCall.kind, 'search')

    const fetchToolCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_3')
    assert.ok(fetchToolCall)
    assert.equal(fetchToolCall.title, 'web_fetch')
    assert.equal(fetchToolCall.kind, 'fetch')

    const thinkToolCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_4')
    assert.ok(thinkToolCall)
    assert.equal(thinkToolCall.title, 'reasoning')
    assert.equal(thinkToolCall.kind, 'think')

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_1')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.equal(toolCallUpdate.content?.[0]?.content?.text, 'hello from bash')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
