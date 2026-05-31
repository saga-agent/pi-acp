import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import { toToolKind } from './tool-kind.js'

export type ToolPermissionBridgeResult = {
  allowed: boolean
  reason?: string
  optionId?: string
}

type ToolPermissionBridgeRequest = {
  toolCallId: string
  toolName: string
  input: unknown
}

type ToolPermissionPolicy = {
  allowed: boolean
}

export function createClientPermissionBridgeHandler(options: {
  conn: AgentSideConnection
  getSessionId: () => string | null | undefined
}): (method: string, params: unknown) => Promise<ToolPermissionBridgeResult> | ToolPermissionBridgeResult {
  const policies = new Map<string, ToolPermissionPolicy>()

  return async (method, params) => {
    if (method !== 'permission/request_tool_call') {
      throw new Error(`Unsupported ACP permission bridge method: ${method}`)
    }

    const request = normalizeToolPermissionRequest(params)
    const policyKey = toolPermissionPolicyKey(request)
    const policy = policies.get(policyKey)
    if (policy) {
      return {
        allowed: policy.allowed,
        optionId: policy.allowed ? 'allow_always' : 'reject_always',
        ...(policy.allowed ? {} : { reason: 'Rejected by remembered ACP permission policy' })
      }
    }

    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available for permission request')

    const permissionRequest = toRequestPermissionRequest(sessionId, request)
    const response = await options.conn.requestPermission(permissionRequest)
    return handlePermissionResponse(response, policies, policyKey)
  }
}

function normalizeToolPermissionRequest(params: unknown): ToolPermissionBridgeRequest {
  const raw = ensureObject(params)
  return {
    toolCallId: requireString(raw.toolCallId, 'toolCallId'),
    toolName: requireString(raw.toolName, 'toolName'),
    input: raw.input ?? null
  }
}

function toRequestPermissionRequest(sessionId: string, request: ToolPermissionBridgeRequest): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: {
      toolCallId: request.toolCallId,
      title: request.toolName,
      kind: toToolKind(request.toolName),
      status: 'pending',
      rawInput: request.input,
      _meta: {
        piAcp: {
          source: 'pi-extension-tool-call',
          toolName: request.toolName
        }
      }
    },
    options: toolPermissionOptions()
  }
}

function toolPermissionOptions(): PermissionOption[] {
  return [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }
  ]
}

function handlePermissionResponse(
  response: RequestPermissionResponse,
  policies: Map<string, ToolPermissionPolicy>,
  policyKey: string
): ToolPermissionBridgeResult {
  const outcome = response.outcome
  if (outcome.outcome === 'cancelled') {
    return { allowed: false, reason: 'ACP permission request cancelled' }
  }

  const optionId = outcome.optionId
  if (optionId === 'allow' || optionId === 'allow_always') {
    if (optionId === 'allow_always') policies.set(policyKey, { allowed: true })
    return { allowed: true, optionId }
  }

  if (optionId === 'reject' || optionId === 'reject_always') {
    if (optionId === 'reject_always') policies.set(policyKey, { allowed: false })
    return { allowed: false, optionId, reason: 'Rejected by ACP client' }
  }

  return { allowed: false, optionId, reason: `Unsupported ACP permission option: ${optionId}` }
}

function toolPermissionPolicyKey(request: ToolPermissionBridgeRequest): string {
  return JSON.stringify({
    method: 'permission/request_tool_call',
    toolName: request.toolName,
    input: stableJsonValue(request.input)
  })
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stableJsonValue(item))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableJsonValue((value as Record<string, unknown>)[key])
  }
  return out
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  return value
}
