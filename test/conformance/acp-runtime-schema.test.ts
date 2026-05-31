import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  get(_sessionId: string) {
    return this.session
  }
}

test('ACP runtime schema validates adapter-owned response and notification paths', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const initialized = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: null,
    _meta: null
  } as any)
  acpSchema.initializeResponse.parse(initialized)
  assert.deepEqual(initialized.agentCapabilities?.sessionCapabilities?.list, {})

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-conformance-'))
  try {
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    acpSchema.listSessionsResponse.parse(listed)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }

  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'all' })
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const prompted = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }],
    _meta: null
  } as any)
  acpSchema.promptResponse.parse(prompted)

  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'agent_message_chunk'))
})

test('ACP runtime schema validates prompt response stop reasons mapped by the adapter', async () => {
  for (const stopReason of ['max_tokens', 'max_turn_requests', 'refusal'] as const) {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    ;(agent as any).sessions = new FakeSessions({
      sessionId: `s-${stopReason}`,
      prompt: async () => stopReason,
      wasCancelRequested: () => false
    }) as any

    const response = await agent.prompt({
      sessionId: `s-${stopReason}`,
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: null
    } as any)

    acpSchema.promptResponse.parse(response)
    assert.deepEqual(response, { stopReason })
  }
})

test('ACP runtime schema validates emitted session/update variants', () => {
  const absolutePath = join(tmpdir(), 'pi-acp-schema-diff.txt')
  const sessionInfoUpdate = {
    sessionUpdate: 'session_info_update',
    title: 'Schema fixture',
    updatedAt: '2026-05-30T00:00:00.000Z',
    _meta: { piAcp: { queueDepth: 0, running: false } }
  }

  assert.equal('sessionId' in sessionInfoUpdate, false)
  assert.equal('cwd' in sessionInfoUpdate, false)

  const updates = [
    {
      name: 'user_message_chunk',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-1',
        content: { type: 'text', text: 'hello' }
      }
    },
    {
      name: 'agent_message_chunk',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'agent-1',
        content: { type: 'text', text: 'hi' }
      }
    },
    {
      name: 'agent_thought_chunk',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-1',
        content: { type: 'text', text: 'thinking' }
      }
    },
    {
      name: 'tool_call',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'edit',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: absolutePath, line: 1 }],
        rawInput: { path: absolutePath, oldText: 'old', newText: 'new' }
      }
    },
    {
      name: 'tool_call_update content',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'progress' } }],
        rawOutput: { chunk: 'progress' }
      }
    },
    {
      name: 'tool_call_update failed content',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-failed',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'tool failed visibly' } }],
        rawOutput: { error: 'tool failed visibly' }
      }
    },
    {
      name: 'tool_call_update diff',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [{ type: 'diff', path: absolutePath, oldText: 'old\n', newText: 'new\n' }]
      }
    },
    {
      name: 'tool_call_update terminal',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-2',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 'terminal-1' }]
      }
    },
    {
      name: 'plan',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect current behavior', priority: 'high', status: 'completed' },
          { content: 'Publish ACP plan', priority: 'medium', status: 'in_progress' },
          { content: 'Verify client rendering', priority: 'low', status: 'pending' }
        ]
      }
    },
    {
      name: 'available_commands_update',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'steering', description: 'Show steering mode' },
          { name: 'skill:test', description: 'Run a skill command', input: { hint: '<args>' } }
        ]
      }
    },
    {
      name: 'current_mode_update',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'medium'
      }
    },
    {
      name: 'config_option_update',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'openai/gpt-5',
            options: [{ value: 'openai/gpt-5', name: 'GPT-5', description: null }]
          },
          {
            id: 'thought_level',
            name: 'Thought Level',
            category: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low', description: null },
              { value: 'medium', name: 'Medium', description: null }
            ]
          }
        ]
      }
    },
    {
      name: 'session_info_update',
      update: sessionInfoUpdate
    }
  ]

  for (const { name, update } of updates) {
    assert.doesNotThrow(
      () => acpSchema.sessionNotification.parse({ sessionId: 'schema-session', update }),
      `expected ${name} fixture to satisfy SDK session/update schema`
    )
  }
})
