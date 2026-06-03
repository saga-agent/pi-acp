import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: includes extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user', input: { hint: '<topic>' } },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo', input: { hint: '<topic>' } },
    { name: 'y', description: '(prompt:project)' }
  ])

  const withoutExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false
  }).commands
  assert.deepEqual(withoutExt, [
    { name: 'skill:foo', description: 'Foo', input: { hint: '<topic>' } },
    { name: 'y', description: '(prompt:project)' }
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [
    { name: 'x', description: 'X' },
    { name: 'y', description: '(prompt:project)' }
  ])
})

test('toAvailableCommandsFromPiGetCommands: preserves command input hints', () => {
  const data = {
    commands: [
      { name: 'from-input-object', description: 'Object', input: { hint: '<value>' } },
      { name: 'from-input-string', description: 'String', input: '<name>' },
      { name: 'from-argument-hint', description: 'Hint', 'argument-hint': '[instructions]' }
    ]
  }

  assert.deepEqual(toAvailableCommandsFromPiGetCommands(data).commands, [
    { name: 'from-input-object', description: 'Object', input: { hint: '<value>' } },
    { name: 'from-input-string', description: 'String', input: { hint: '<name>' } },
    { name: 'from-argument-hint', description: 'Hint', input: { hint: '[instructions]' } }
  ])
})
