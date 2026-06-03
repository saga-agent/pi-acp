import type { AvailableCommand } from '@agentclientprotocol/sdk'

export type PiRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  path?: unknown
  input?: unknown
  argumentHint?: unknown
  'argument-hint'?: unknown
}

function describeFallback(c: PiRpcCommandInfo): string {
  const source = typeof c.source === 'string' ? c.source : ''
  const location = typeof c.location === 'string' ? c.location : ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

function numericInvocationSuffixBase(name: string): string | null {
  const match = name.match(/^(.+):[1-9]\d*$/)
  return match?.[1] ?? null
}

function duplicateInvocationSuffixBases(commands: PiRpcCommandInfo[]): Set<string> {
  const counts = new Map<string, number>()

  for (const c of commands) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    const source = typeof c?.source === 'string' ? c.source : ''
    if (!name || source !== 'extension') continue

    const base = numericInvocationSuffixBase(name)
    if (!base) continue

    counts.set(base, (counts.get(base) ?? 0) + 1)
  }

  return new Set([...counts].filter(([, count]) => count > 1).map(([base]) => base))
}

function commandInput(c: PiRpcCommandInfo): AvailableCommand['input'] | undefined {
  const input = c.input
  if (input && typeof input === 'object' && typeof (input as { hint?: unknown }).hint === 'string') {
    const hint = (input as { hint: string }).hint.trim()
    return hint ? { hint } : undefined
  }

  const hint =
    typeof c.argumentHint === 'string'
      ? c.argumentHint.trim()
      : typeof c['argument-hint'] === 'string'
        ? c['argument-hint'].trim()
        : typeof input === 'string'
          ? input.trim()
          : ''

  return hint ? { hint } : undefined
}

export function toAvailableCommandsFromPiGetCommands(
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean }
): {
  commands: AvailableCommand[]
  raw: PiRpcCommandInfo[]
} {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const includeExtensionCommands = opts?.includeExtensionCommands ?? true

  const root: any = data
  const commandsRaw: PiRpcCommandInfo[] = Array.isArray(root?.commands)
    ? root.commands
    : Array.isArray(root?.data?.commands)
      ? root.data.commands
      : []

  const out: AvailableCommand[] = []
  const duplicateSuffixBases = duplicateInvocationSuffixBases(commandsRaw)
  const emittedDuplicateSuffixBases = new Set<string>()

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (!includeExtensionCommands && source === 'extension') continue

    const duplicateSuffixBase = source === 'extension' ? numericInvocationSuffixBase(name) : null
    if (duplicateSuffixBase && duplicateSuffixBases.has(duplicateSuffixBase)) {
      if (emittedDuplicateSuffixBases.has(duplicateSuffixBase)) continue
      emittedDuplicateSuffixBases.add(duplicateSuffixBase)
    }

    if (!enableSkillCommands && name.startsWith('skill:')) continue

    const desc = typeof c?.description === 'string' ? c.description.trim() : ''

    const available: AvailableCommand = {
      name,
      description: desc || describeFallback(c)
    }
    const input = commandInput(c)
    if (input) available.input = input
    out.push(available)
  }

  return { commands: out, raw: commandsRaw }
}
