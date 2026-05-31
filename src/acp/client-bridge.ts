import type { AgentSideConnection, ClientCapabilities } from '@agentclientprotocol/sdk'
import type { BridgeRpcHandler } from '../pi-rpc/bridge-rpc.js'
import { createClientFsBridgeHandler } from './client-fs.js'
import { createClientPermissionBridgeHandler } from './client-permissions.js'
import { createClientPlanBridgeHandler } from './client-plan.js'
import { createClientStopReasonBridgeHandler, type PromptStopReasonOverrideStore } from './client-stop-reasons.js'
import { createClientTerminalBridgeHandler } from './client-terminal.js'
import { createPromptResourceBridgeHandler, type PromptResourceStore } from './prompt-resources.js'

export function shouldStartClientBridgeRpc(_capabilities: ClientCapabilities | null | undefined): boolean {
  // Prompt resource access is adapter-owned and does not require an advertised
  // client capability, so the bridge should exist even when fs/terminal are absent.
  return true
}

export function createClientBridgeRpcHandler(options: {
  conn: AgentSideConnection
  clientCapabilities: ClientCapabilities | null | undefined
  getSessionId: () => string | null | undefined
  promptResourceStore?: PromptResourceStore | null
  stopReasonOverrides?: PromptStopReasonOverrideStore | null
}): BridgeRpcHandler {
  const fsHandler = createClientFsBridgeHandler(options)
  const terminalHandler = createClientTerminalBridgeHandler(options)
  const promptResourceHandler = createPromptResourceBridgeHandler(options)
  const permissionHandler = createClientPermissionBridgeHandler(options)
  const planHandler = createClientPlanBridgeHandler(options)
  const stopReasonHandler = createClientStopReasonBridgeHandler(options)

  return (method, params) => {
    if (method.startsWith('fs/')) return fsHandler(method, params)
    if (method.startsWith('terminal/')) return terminalHandler(method, params)
    if (method.startsWith('resource/')) return promptResourceHandler(method, params)
    if (method.startsWith('permission/')) return permissionHandler(method, params)
    if (method.startsWith('plan/')) return planHandler(method, params)
    if (method.startsWith('prompt/')) return stopReasonHandler(method, params)
    throw new Error(`Unsupported ACP bridge method: ${method}`)
  }
}
