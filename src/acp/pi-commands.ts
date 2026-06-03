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

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (!includeExtensionCommands && source === 'extension') continue

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
