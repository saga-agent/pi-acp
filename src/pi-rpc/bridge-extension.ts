import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startBridgeRpcServer,
  type BridgeRpcEndpoint,
  type BridgeRpcHandler,
  type BridgeRpcServer
} from './bridge-rpc.js'

export const ACP_BRIDGE_SETUP_ENV = 'PI_ACP_BRIDGE_SETUP'
export const ACP_BRIDGE_EXTENSION_ENV = 'PI_ACP_BRIDGE_EXTENSION'
export const ACP_BRIDGE_DISABLE_ENV = 'PI_ACP_DISABLE_BRIDGE_EXTENSION'

export type PiAcpBridgeSetup = {
  version: 1
  lifecycle: 'new' | 'load' | 'resume'
  cwd: string
  sessionId: string | null
  mcpServers: unknown[]
  clientCapabilities: unknown | null
  toolCallPermissions?: {
    enabled: boolean
    toolNames: string[]
  }
  adapterRpc?: BridgeRpcEndpoint | null
  createdAt: string
}

export type PreparedPiAcpBridge = {
  extensionPath: string
  setupPath: string
  env: Record<string, string>
  adapterRpc: BridgeRpcServer | null
  cleanup: () => void
}

export function isBridgeExtensionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ACP_BRIDGE_DISABLE_ENV]
  return raw !== '1' && raw?.toLowerCase() !== 'true'
}

export function resolveBridgeExtensionPath(
  baseUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env[ACP_BRIDGE_EXTENSION_ENV]
  if (override) {
    if (!existsSync(override)) throw new Error(`ACP bridge extension override not found: ${override}`)
    return override
  }

  const here = dirname(fileURLToPath(baseUrl))
  const candidates = [
    resolve(here, 'pi-extension', 'acp-bridge.js'),
    resolve(here, '..', 'pi-extension', 'acp-bridge.js'),
    resolve(here, '..', 'acp-bridge.js'),
    resolve(here, '..', 'pi-extension', 'acp-bridge.ts')
  ]

  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    throw new Error(`ACP bridge extension not found. Tried: ${candidates.join(', ')}`)
  }

  return found
}

export function preparePiAcpBridge(
  setup: PiAcpBridgeSetup,
  opts?: {
    baseUrl?: string
    env?: NodeJS.ProcessEnv
  }
): PreparedPiAcpBridge | null {
  const env = opts?.env ?? process.env
  if (!isBridgeExtensionEnabled(env)) return null

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
  const setupPath = join(dir, 'setup.json')

  try {
    writeFileSync(setupPath, JSON.stringify(setup, null, 2), 'utf8')
    return {
      extensionPath: resolveBridgeExtensionPath(opts?.baseUrl ?? import.meta.url, env),
      setupPath,
      env: { [ACP_BRIDGE_SETUP_ENV]: setupPath },
      adapterRpc: null,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }
    }
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
    throw err
  }
}

export async function preparePiAcpBridgeWithRpc(
  setup: PiAcpBridgeSetup,
  opts?: {
    baseUrl?: string
    env?: NodeJS.ProcessEnv
    handler?: BridgeRpcHandler | null
  }
): Promise<PreparedPiAcpBridge | null> {
  const env = opts?.env ?? process.env
  if (!isBridgeExtensionEnabled(env)) return null

  const adapterRpc = opts?.handler ? await startBridgeRpcServer(opts.handler) : null
  const preparedSetup = adapterRpc ? { ...setup, adapterRpc: adapterRpc.endpoint } : setup

  try {
    const prepared = preparePiAcpBridge(preparedSetup, { baseUrl: opts?.baseUrl, env })
    if (!prepared) {
      adapterRpc?.close()
      return null
    }

    return {
      ...prepared,
      adapterRpc,
      cleanup: () => {
        adapterRpc?.close()
        prepared.cleanup()
      }
    }
  } catch (err) {
    adapterRpc?.close()
    throw err
  }
}
