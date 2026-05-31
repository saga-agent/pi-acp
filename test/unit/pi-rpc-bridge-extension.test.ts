import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACP_BRIDGE_DISABLE_ENV,
  ACP_BRIDGE_EXTENSION_ENV,
  ACP_BRIDGE_SETUP_ENV,
  isBridgeExtensionEnabled,
  preparePiAcpBridge,
  preparePiAcpBridgeWithRpc,
  resolveBridgeExtensionPath,
  type PiAcpBridgeSetup
} from '../../src/pi-rpc/bridge-extension.js'
import { buildPiRpcArgs } from '../../src/pi-rpc/process.js'

const setup: PiAcpBridgeSetup = {
  version: 1,
  lifecycle: 'new',
  cwd: '/tmp/project',
  sessionId: null,
  mcpServers: [{ name: 'test-mcp', command: '/bin/echo', args: [], env: {} }],
  clientCapabilities: { fs: { readTextFile: true } },
  createdAt: '2026-05-30T00:00:00.000Z'
}

test('ACP bridge extension: prepares setup file and spawn args', () => {
  const prepared = preparePiAcpBridge(setup, {
    env: {},
    baseUrl: new URL('../../src/pi-rpc/bridge-extension.ts', import.meta.url).href
  })
  assert.ok(prepared)

  try {
    assert.equal(prepared.env[ACP_BRIDGE_SETUP_ENV], prepared.setupPath)
    assert.ok(existsSync(prepared.extensionPath))
    assert.ok(prepared.extensionPath.endsWith('acp-bridge.ts') || prepared.extensionPath.endsWith('acp-bridge.js'))

    const raw = JSON.parse(readFileSync(prepared.setupPath, 'utf8'))
    assert.deepEqual(raw, setup)

    assert.deepEqual(
      buildPiRpcArgs({ sessionPath: '/tmp/session.jsonl', bridgeExtensionPath: prepared.extensionPath }),
      ['--mode', 'rpc', '--no-themes', '--session', '/tmp/session.jsonl', '--extension', prepared.extensionPath]
    )
  } finally {
    prepared.cleanup()
  }

  assert.equal(existsSync(prepared.setupPath), false)
})

test('ACP bridge extension: supports explicit enable, disable, and override paths', () => {
  assert.equal(isBridgeExtensionEnabled({}), true)
  assert.equal(isBridgeExtensionEnabled({ [ACP_BRIDGE_DISABLE_ENV]: '1' }), false)
  assert.equal(isBridgeExtensionEnabled({ [ACP_BRIDGE_DISABLE_ENV]: 'true' }), false)

  const env = {
    [ACP_BRIDGE_EXTENSION_ENV]: new URL('../../src/pi-extension/acp-bridge.ts', import.meta.url).pathname
  }
  assert.equal(resolveBridgeExtensionPath(import.meta.url, env), env[ACP_BRIDGE_EXTENSION_ENV])

  const disabled = preparePiAcpBridge(setup, { env: { [ACP_BRIDGE_DISABLE_ENV]: 'true' } })
  assert.equal(disabled, null)
})

test('ACP bridge extension: resolves bundled extension from built dist layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-dist-bridge-'))
  try {
    const dist = join(root, 'dist')
    const extensionDir = join(dist, 'pi-extension')
    mkdirSync(extensionDir, { recursive: true })
    const bridgePath = join(extensionDir, 'acp-bridge.js')
    writeFileSync(bridgePath, '// bridge\\n', 'utf8')

    assert.equal(resolveBridgeExtensionPath(new URL(`file://${dist}/index.js`).href, {}), bridgePath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ACP bridge extension: can include an adapter RPC endpoint in setup', async () => {
  const prepared = await preparePiAcpBridgeWithRpc(setup, {
    env: {},
    baseUrl: new URL('../../src/pi-rpc/bridge-extension.ts', import.meta.url).href,
    handler: async () => ({ ok: true })
  })
  assert.ok(prepared)

  try {
    const raw = JSON.parse(readFileSync(prepared.setupPath, 'utf8'))
    assert.equal(raw.adapterRpc.host, '127.0.0.1')
    assert.equal(typeof raw.adapterRpc.port, 'number')
    assert.equal(typeof raw.adapterRpc.token, 'string')
    assert.deepEqual(prepared.adapterRpc?.endpoint, raw.adapterRpc)
  } finally {
    prepared.cleanup()
  }
})
