import type { AgentSideConnection, PlanEntry } from '@agentclientprotocol/sdk'

type PlanBridgeRequest = {
  entries: PlanEntry[]
}

export function createClientPlanBridgeHandler(options: {
  conn: AgentSideConnection
  getSessionId: () => string | null | undefined
}): (method: string, params: unknown) => Promise<Record<string, never>> | Record<string, never> {
  return async (method, params) => {
    if (method !== 'plan/update') {
      throw new Error(`Unsupported ACP plan bridge method: ${method}`)
    }

    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available for plan update')

    const request = normalizePlanBridgeRequest(params)
    await options.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: request.entries
      }
    })
    return {}
  }
}

function normalizePlanBridgeRequest(params: unknown): PlanBridgeRequest {
  const raw = ensureObject(params)
  const entries = raw.entries
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  return {
    entries: entries.map((entry, index) => normalizePlanEntry(entry, index))
  }
}

function normalizePlanEntry(value: unknown, index: number): PlanEntry {
  const raw = ensureObject(value)
  const priority = raw.priority
  const status = raw.status
  if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    throw new Error(`entries[${index}].priority must be high, medium, or low`)
  }
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
    throw new Error(`entries[${index}].status must be pending, in_progress, or completed`)
  }

  const meta = raw._meta
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw new Error(`entries[${index}]._meta must be an object or null`)
  }

  return {
    content: requireString(raw.content, `entries[${index}].content`),
    priority,
    status,
    ...(meta === undefined ? {} : { _meta: meta as Record<string, unknown> | null })
  }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}
