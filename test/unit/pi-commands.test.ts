import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: includes extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const withoutExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false
  }).commands
  assert.deepEqual(withoutExt, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [
    { name: 'x', description: 'X' },
    { name: 'y', description: '(prompt:project)' }
  ])
})

test('toAvailableCommandsFromPiGetCommands: collapses pi numeric suffix duplicates to the first invocation', () => {
  const data = {
    commands: [
      { name: 'hot-hook:1', description: 'Hot hook first', source: 'extension' },
      { name: 'hot-hook:2', description: 'Hot hook second', source: 'extension' },
      { name: 'other:1', description: 'A real single suffixed command', source: 'extension' },
      { name: 'skill:topic:1', description: 'Skill command keeps suffix', source: 'skill' }
    ]
  }

  assert.deepEqual(toAvailableCommandsFromPiGetCommands(data).commands, [
    { name: 'hot-hook:1', description: 'Hot hook first' },
    { name: 'other:1', description: 'A real single suffixed command' },
    { name: 'skill:topic:1', description: 'Skill command keeps suffix' }
  ])
})
