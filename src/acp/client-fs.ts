import { isAbsolute } from 'node:path'
import type { AgentSideConnection, ClientCapabilities } from '@agentclientprotocol/sdk'
import type { BridgeRpcHandler } from '../pi-rpc/bridge-rpc.js'

export function supportsClientFsRead(capabilities: ClientCapabilities | null | undefined): boolean {
  return capabilities?.fs?.readTextFile === true
}

export function supportsClientFsWrite(capabilities: ClientCapabilities | null | undefined): boolean {
  return capabilities?.fs?.writeTextFile === true
}

export function supportsAnyClientFs(capabilities: ClientCapabilities | null | undefined): boolean {
  return supportsClientFsRead(capabilities) || supportsClientFsWrite(capabilities)
}

export function createClientFsBridgeHandler(options: {
  conn: AgentSideConnection
  clientCapabilities: ClientCapabilities | null | undefined
  getSessionId: () => string | null | undefined
}): BridgeRpcHandler {
  return async (method, params) => {
    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available yet')

    if (method === 'fs/read_text_file') {
      if (!supportsClientFsRead(options.clientCapabilities)) {
        throw new Error('ACP client did not advertise fs.readTextFile')
      }

      const request = normalizeReadTextFileParams(params)
      return options.conn.readTextFile({ sessionId, ...request })
    }

    if (method === 'fs/write_text_file') {
      if (!supportsClientFsWrite(options.clientCapabilities)) {
        throw new Error('ACP client did not advertise fs.writeTextFile')
      }

      const request = normalizeWriteTextFileParams(params)
      await options.conn.writeTextFile({ sessionId, ...request })
      return {}
    }

    throw new Error(`Unsupported ACP bridge method: ${method}`)
  }
}

function normalizeReadTextFileParams(params: unknown): { path: string; line?: number | null; limit?: number | null } {
  const raw = ensureObject(params)
  const path = requireAbsolutePath(raw.path)
  const line = optionalNonNegativeInteger(raw.line, 'line')
  const limit = optionalNonNegativeInteger(raw.limit, 'limit')
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(limit === undefined ? {} : { limit })
  }
}

function normalizeWriteTextFileParams(params: unknown): { path: string; content: string } {
  const raw = ensureObject(params)
  const path = requireAbsolutePath(raw.path)
  if (typeof raw.content !== 'string') throw new Error('content must be a string')
  return { path, content: raw.content }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function requireAbsolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('path must be a non-empty string')
  if (!isAbsolute(value)) throw new Error(`path must be absolute: ${value}`)
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
