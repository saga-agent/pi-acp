import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandSlashCommand,
  loadSlashCommands,
  parseCommandArgs,
  substituteArgs,
  toAvailableCommands
} from '../../src/acp/slash-commands.js'

test('parseCommandArgs: handles quotes', () => {
  assert.deepEqual(parseCommandArgs('a b'), ['a', 'b'])
  assert.deepEqual(parseCommandArgs("'a b' c"), ['a b', 'c'])
  assert.deepEqual(parseCommandArgs('"a b" c'), ['a b', 'c'])
})

test('substituteArgs: replaces $1.. and $@', () => {
  assert.equal(substituteArgs('x=$1 y=$2 all=$@', ['one', 'two']).trim(), 'x=one y=two all=one two')
  assert.equal(substituteArgs('$3', ['one']).trim(), '')
})

test('substituteArgs: replaces pi prompt-template aggregate argument forms', () => {
  assert.equal(
    substituteArgs('all=$ARGUMENTS tail=${@:2} two=${@:2:2}', ['one', 'two', 'three', 'four']).trim(),
    'all=one two three four tail=two three four two=two three'
  )
})

test('expandSlashCommand: expands known command', () => {
  const cmds = [{ name: 'hello', description: '(user)', content: 'Say hi to $1', source: '(user)' }]

  assert.equal(expandSlashCommand('/hello world', cmds as any), 'Say hi to world')
  assert.equal(expandSlashCommand('/unknown world', cmds as any), '/unknown world')
  assert.equal(expandSlashCommand('not a command', cmds as any), 'not a command')
})

test('toAvailableCommands: de-dupes by name (first wins)', () => {
  const cmds = [
    { name: 'x', description: 'first', content: '1', source: '(user)', inputHint: '<topic>' },
    { name: 'x', description: 'second', content: '2', source: '(project)' }
  ]

  assert.deepEqual(toAvailableCommands(cmds as any), [
    { name: 'x', description: 'first', input: { hint: '<topic>' } }
  ])
})

test('loadSlashCommands: reads argument-hint frontmatter for ACP command input', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-slash-command-'))
  const promptsDir = join(cwd, '.pi', 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(
    join(promptsDir, 'review-pr.md'),
    [
      '---',
      'description: Review a PR',
      'argument-hint: "<PR-URL>"',
      '---',
      'Review $ARGUMENTS'
    ].join('\n')
  )

  const command = toAvailableCommands(loadSlashCommands(cwd)).find(c => c.name === 'review-pr')
  assert.deepEqual(command, {
    name: 'review-pr',
    description: 'Review a PR (project)',
    input: { hint: '<PR-URL>' }
  })
})
