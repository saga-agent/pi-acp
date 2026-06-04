import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { acpSchema } from '../helpers/acp-schema.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  acpSchema.sessionNotification.parse({ sessionId: 's1', update: (info as any)?.update })
  assert.equal((info as any)?.update?.title, 'My Session')
  assert.equal(Object.prototype.hasOwnProperty.call((info as any)?.update ?? {}, 'sessionId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call((info as any)?.update ?? {}, 'cwd'), false)

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

test('PiAcpAgent: advertised built-in commands include every documented slash command', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    create: async () => ({
      sessionId: 's1',
      proc,
      fileCommands: [],
      setStartupInfo: () => {},
      sendStartupInfoIfPending: async () => {}
    })
  } as any

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  await new Promise(resolve => setImmediate(resolve))

  const commandsUpdate = conn.updates.find(update => update.update?.sessionUpdate === 'available_commands_update')
  const names = new Set(((commandsUpdate as any)?.update?.availableCommands ?? []).map((command: any) => command.name))
  for (const command of [
    'compact',
    'autocompact',
    'export',
    'session',
    'name',
    'queue',
    'steering',
    'follow-up',
    'changelog',
    'model',
    'thinking',
    'think',
    'clear'
  ]) {
    assert.ok(names.has(command), `expected /${command} to be advertised`)
  }
})

test('PiAcpAgent: /queue sets steering and follow-up modes adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/queue all' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.steeringMode, 'all')
  assert.equal(proc.followUpMode, 'all')
  assert.equal(proc.prompts.length, 0)
  assert.match((conn.updates.at(-1) as any).update.content.text, /Queue mode set to: all/)
})

test('PiAcpAgent: /model reports and sets model adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const report = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/model' }]
  } as any)
  assert.equal(report.stopReason, 'end_turn')
  assert.match((conn.updates.at(-1) as any).update.content.text, /Current model: test\/model/)

  const set = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/model test/model' }]
  } as any)
  assert.equal(set.stopReason, 'end_turn')
  assert.equal(proc.model.id, 'model')
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'config_option_update'))
  assert.match((conn.updates.at(-1) as any).update.content.text, /Model set to: test\/model/)
})

test('PiAcpAgent: /thinking reports and sets thought level adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const report = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/thinking' }]
  } as any)
  assert.equal(report.stopReason, 'end_turn')
  assert.match((conn.updates.at(-1) as any).update.content.text, /Thought level: medium/)

  const set = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/thinking high' }]
  } as any)
  assert.equal(set.stopReason, 'end_turn')
  assert.equal(proc.thinkingLevel, 'high')
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'current_mode_update'))
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'config_option_update'))
  assert.match((conn.updates.at(-1) as any).update.content.text, /Thought level set to: high/)
})

test('PiAcpAgent: /think aliases /thinking', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const report = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/think' }]
  } as any)
  assert.equal(report.stopReason, 'end_turn')
  assert.match((conn.updates.at(-1) as any).update.content.text, /Thought level: medium/)

  const set = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/think low' }]
  } as any)
  assert.equal(set.stopReason, 'end_turn')
  assert.equal(proc.thinkingLevel, 'low')
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'current_mode_update'))
  assert.ok(conn.updates.some(update => update.update?.sessionUpdate === 'config_option_update'))
  assert.match((conn.updates.at(-1) as any).update.content.text, /Thought level set to: low/)
})

test('PiAcpAgent: /clear is handled visibly adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/clear' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.match((conn.updates.at(-1) as any).update.content.text, /new-session control/)
})
