import { isAbsolute } from 'node:path'
import type {
  AgentSideConnection,
  ClientCapabilities,
  CreateTerminalRequest,
  EnvVariable
} from '@agentclientprotocol/sdk'
import type { BridgeRpcHandler } from '../pi-rpc/bridge-rpc.js'

type TerminalHandleLike = Awaited<ReturnType<AgentSideConnection['createTerminal']>>
type CreateTerminalBridgeRequest = Omit<CreateTerminalRequest, 'sessionId'>

export function supportsClientTerminal(capabilities: ClientCapabilities | null | undefined): boolean {
  return capabilities?.terminal === true
}

export function createClientTerminalBridgeHandler(options: {
  conn: AgentSideConnection
  clientCapabilities: ClientCapabilities | null | undefined
  getSessionId: () => string | null | undefined
}): BridgeRpcHandler {
  const terminals = new Map<string, TerminalHandleLike>()

  return async (method, params) => {
    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available yet')

    if (!supportsClientTerminal(options.clientCapabilities)) {
      throw new Error('ACP client did not advertise terminal support')
    }

    if (method === 'terminal/create') {
      const request = normalizeCreateTerminalParams(params)
      const handle = await options.conn.createTerminal({ sessionId, ...request })
      if (!handle || typeof handle.id !== 'string' || !handle.id) {
        throw new Error('ACP client returned invalid terminal handle')
      }

      terminals.set(handle.id, handle)
      return { terminalId: handle.id }
    }

    if (method === 'terminal/output') {
      return getTerminal(terminals, params).currentOutput()
    }

    if (method === 'terminal/wait_for_exit') {
      return getTerminal(terminals, params).waitForExit()
    }

    if (method === 'terminal/kill') {
      await getTerminal(terminals, params).kill()
      return {}
    }

    if (method === 'terminal/release') {
      const terminalId = normalizeTerminalIdParams(params)
      const terminal = terminals.get(terminalId)
      if (!terminal) throw new Error(`Unknown ACP terminal id: ${terminalId}`)

      try {
        await terminal.release()
        return {}
      } finally {
        terminals.delete(terminalId)
      }
    }

    throw new Error(`Unsupported ACP bridge method: ${method}`)
  }
}

function getTerminal(terminals: Map<string, TerminalHandleLike>, params: unknown): TerminalHandleLike {
  const terminalId = normalizeTerminalIdParams(params)
  const terminal = terminals.get(terminalId)
  if (!terminal) throw new Error(`Unknown ACP terminal id: ${terminalId}`)
  return terminal
}

function normalizeCreateTerminalParams(params: unknown): CreateTerminalBridgeRequest {
  const raw = ensureObject(params)
  const command = requireString(raw.command, 'command')
  const args = optionalStringArray(raw.args, 'args')
  const env = optionalEnv(raw.env)
  const cwd = optionalAbsolutePath(raw.cwd, 'cwd')
  const outputByteLimit = optionalNonNegativeInteger(raw.outputByteLimit, 'outputByteLimit')

  return {
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(outputByteLimit === undefined ? {} : { outputByteLimit })
  }
}

function normalizeTerminalIdParams(params: unknown): string {
  const raw = ensureObject(params)
  return requireString(raw.terminalId, 'terminalId')
}

function optionalEnv(value: unknown): EnvVariable[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('env must be an array of {name,value} objects')

  return value.map((item, index) => {
    const raw = ensureObject(item)
    return {
      name: requireString(raw.name, `env[${index}].name`),
      value: requireEnvValue(raw.value, `env[${index}].value`)
    }
  })
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  return value
}

function requireEnvValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value
}

function optionalAbsolutePath(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute: ${value}`)
  return value
}

function optionalNonNegativeInteger(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}
