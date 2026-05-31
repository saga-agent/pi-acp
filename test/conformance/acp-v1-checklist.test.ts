import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAcpAgent } from '../../src/acp/agent.js'

type Meta = {
  protocolVersion: number
  agentMethods: string[]
  clientMethods: string[]
  sessionUpdates: string[]
  contentBlocks: string[]
  stopReasons: string[]
  toolKinds: string[]
  toolStatuses: string[]
  toolContents: string[]
  permissionOptionKinds: string[]
  permissionOutcomes: string[]
  agentCapabilityGates: string[]
  clientCapabilityGates: string[]
  transportRequirements: string[]
}

type ChecklistEntry = {
  surface: string
  name: string
  status: string
  priority: string
  owners: string[]
  evidence: string[]
  next: string
}

type Checklist = {
  schemaVersion: number
  protocolVersion: number
  architecturePrinciples: string[]
  entries: ChecklistEntry[]
  knownSdkDrift?: {
    installedPackage: string
    installedVersion: string
    latestObservedVersion: string
    notes: string[]
  }
}

const here = dirname(fileURLToPath(import.meta.url))

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(here, name), 'utf8')) as T
}

const meta = readJson<Meta>('acp-v1-meta.json')
const checklist = readJson<Checklist>('acp-v1-checklist.json')

const requiredSurfaces: Array<[keyof Meta, string]> = [
  ['agentMethods', 'agent_method'],
  ['clientMethods', 'client_method'],
  ['sessionUpdates', 'session_update'],
  ['contentBlocks', 'content_block'],
  ['stopReasons', 'stop_reason'],
  ['toolKinds', 'tool_kind'],
  ['toolStatuses', 'tool_status'],
  ['toolContents', 'tool_content'],
  ['permissionOptionKinds', 'permission_option_kind'],
  ['permissionOutcomes', 'permission_outcome'],
  ['agentCapabilityGates', 'agent_capability_gate'],
  ['clientCapabilityGates', 'client_capability_gate'],
  ['transportRequirements', 'transport_requirement']
]

const allowedStatuses = new Set(['implemented', 'partial', 'missing', 'not_advertised', 'external_gap'])
const allowedPriorities = new Set(['p0', 'p1', 'p2', 'p3'])

test('ACP v1 checklist targets the same protocol version as the frozen meta inventory', () => {
  assert.equal(checklist.schemaVersion, 1)
  assert.equal(checklist.protocolVersion, meta.protocolVersion)
})

test('ACP v1 checklist covers every stable method, update, content, tool, capability, and transport surface', () => {
  const entries = new Set(checklist.entries.map(entry => `${entry.surface}:${entry.name}`))
  const missing: string[] = []

  for (const [metaKey, surface] of requiredSurfaces) {
    const names = meta[metaKey]
    assert.ok(Array.isArray(names), `${String(metaKey)} must be an array`)

    for (const name of names) {
      const key = `${surface}:${name}`
      if (!entries.has(key)) missing.push(key)
    }
  }

  assert.deepEqual(missing, [])
})

test('ACP v1 checklist has no duplicate surface entries', () => {
  const seen = new Set<string>()
  const duplicates: string[] = []

  for (const entry of checklist.entries) {
    const key = `${entry.surface}:${entry.name}`
    if (seen.has(key)) duplicates.push(key)
    seen.add(key)
  }

  assert.deepEqual(duplicates, [])
})

test('ACP v1 checklist entries have actionable status, ownership, and next steps', () => {
  const errors: string[] = []

  for (const entry of checklist.entries) {
    const key = `${entry.surface}:${entry.name}`

    if (!allowedStatuses.has(entry.status)) errors.push(`${key}: invalid status ${entry.status}`)
    if (!allowedPriorities.has(entry.priority)) errors.push(`${key}: invalid priority ${entry.priority}`)
    if (!Array.isArray(entry.owners) || entry.owners.length === 0) errors.push(`${key}: missing owners`)
    if (!Array.isArray(entry.evidence)) errors.push(`${key}: evidence must be an array`)
    if (typeof entry.next !== 'string' || entry.next.trim().length < 10)
      errors.push(`${key}: next step is not actionable`)
  }

  assert.deepEqual(errors, [])
})

test('ACP v1 checklist encodes the extension-first architecture constraint', () => {
  assert.ok(
    checklist.architecturePrinciples.some(principle => principle.toLowerCase().includes('extension')),
    'architecturePrinciples must mention extension-first implementation'
  )

  const barePiOwners = checklist.entries
    .filter(entry => entry.owners.includes('pi'))
    .map(entry => `${entry.surface}:${entry.name}`)

  assert.deepEqual(barePiOwners, [])

  const baseFallbackWithoutExtension = checklist.entries
    .filter(entry => entry.owners.includes('pi-base-fallback') && !entry.owners.includes('pi-extension'))
    .map(entry => `${entry.surface}:${entry.name}`)

  assert.deepEqual(baseFallbackWithoutExtension, [])
})

test('ACP v1 checklist records SDK drift instead of silently treating the installed SDK as authoritative', () => {
  assert.equal(checklist.knownSdkDrift?.installedPackage, '@agentclientprotocol/sdk')
  assert.ok(checklist.knownSdkDrift?.installedVersion)
  assert.ok(checklist.knownSdkDrift?.latestObservedVersion)
  assert.ok((checklist.knownSdkDrift?.notes ?? []).length >= 2)
})

test('ACP adapter serves session/set_model only as an explicit SDK compatibility method', () => {
  assert.ok(!meta.agentMethods.includes('session/set_model'))

  const agent = new PiAcpAgent({} as any)
  assert.equal(typeof (agent as any).unstable_setSessionModel, 'function')
})
