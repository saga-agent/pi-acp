export type ExtensionPromptStopReason = 'max_turn_requests' | 'refusal'

export type PromptStopReasonOverride = {
  stopReason: ExtensionPromptStopReason
  source?: string
}

export type RefusalHistoryRestoreResult = {
  restored: boolean
  reason?: string
  source?: string
  sessionId?: string
  safeLeafId?: string | null
  userEntryId?: string | null
}

export class PromptStopReasonOverrideStore {
  private readonly overrides = new Map<string, PromptStopReasonOverride>()
  private readonly refusalHistoryRestores = new Map<string, RefusalHistoryRestoreResult>()

  set(sessionId: string, override: PromptStopReasonOverride): void {
    this.overrides.set(sessionId, override)
  }

  take(sessionId: string): PromptStopReasonOverride | null {
    const override = this.overrides.get(sessionId) ?? null
    this.overrides.delete(sessionId)
    return override
  }

  clear(sessionId: string): void {
    this.overrides.delete(sessionId)
    this.refusalHistoryRestores.delete(sessionId)
  }

  recordRefusalHistoryRestore(sessionId: string, result: RefusalHistoryRestoreResult): void {
    this.refusalHistoryRestores.set(sessionId, result)
  }

  takeRefusalHistoryRestore(sessionId: string): RefusalHistoryRestoreResult | null {
    const result = this.refusalHistoryRestores.get(sessionId) ?? null
    this.refusalHistoryRestores.delete(sessionId)
    return result
  }
}

export function createClientStopReasonBridgeHandler(options: {
  getSessionId: () => string | null | undefined
  stopReasonOverrides?: PromptStopReasonOverrideStore | null
}): (method: string, params: unknown) => Record<string, never> {
  return (method, params) => {
    if (method === 'prompt/refusal_history_restore_result') {
      const store = options.stopReasonOverrides
      if (!store) throw new Error('ACP prompt stop-reason bridge is not available')

      const sessionId = normalizeSessionId(params) ?? options.getSessionId()
      if (!sessionId) throw new Error('ACP session id is not available for refusal history restore result')

      store.recordRefusalHistoryRestore(sessionId, normalizeRefusalHistoryRestoreResult(params))
      return {}
    }

    if (method !== 'prompt/set_stop_reason') {
      throw new Error(`Unsupported ACP prompt bridge method: ${method}`)
    }

    const store = options.stopReasonOverrides
    if (!store) throw new Error('ACP prompt stop-reason bridge is not available')

    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available for prompt stop reason')

    store.set(sessionId, normalizePromptStopReasonOverride(params))
    return {}
  }
}

function normalizeSessionId(params: unknown): string | null {
  const raw = ensureObject(params)
  const sessionId = raw.sessionId
  if (sessionId === undefined || sessionId === null || sessionId === '') return null
  if (typeof sessionId !== 'string') throw new Error('sessionId must be a string')
  return sessionId
}

function normalizeRefusalHistoryRestoreResult(params: unknown): RefusalHistoryRestoreResult {
  const raw = ensureObject(params)
  const restored = raw.restored
  if (typeof restored !== 'boolean') throw new Error('restored must be a boolean')

  const reason = raw.reason
  if (reason !== undefined && typeof reason !== 'string') throw new Error('reason must be a string')

  const source = raw.source
  if (source !== undefined && typeof source !== 'string') throw new Error('source must be a string')

  const sessionId = raw.sessionId
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    throw new Error('sessionId must be a string')
  }

  const safeLeafId = raw.safeLeafId
  if (safeLeafId !== undefined && safeLeafId !== null && typeof safeLeafId !== 'string') {
    throw new Error('safeLeafId must be a string or null')
  }

  const userEntryId = raw.userEntryId
  if (userEntryId !== undefined && userEntryId !== null && typeof userEntryId !== 'string') {
    throw new Error('userEntryId must be a string or null')
  }

  return {
    restored,
    ...(reason === undefined || reason === '' ? {} : { reason }),
    ...(source === undefined || source === '' ? {} : { source }),
    ...(sessionId === undefined || sessionId === null || sessionId === '' ? {} : { sessionId }),
    ...(safeLeafId === undefined ? {} : { safeLeafId }),
    ...(userEntryId === undefined ? {} : { userEntryId })
  }
}

function normalizePromptStopReasonOverride(params: unknown): PromptStopReasonOverride {
  const raw = ensureObject(params)
  const stopReason = raw.stopReason
  if (stopReason !== 'max_turn_requests' && stopReason !== 'refusal') {
    throw new Error('stopReason must be max_turn_requests or refusal')
  }

  const source = raw.source
  if (source !== undefined && typeof source !== 'string') throw new Error('source must be a string')

  return {
    stopReason,
    ...(source === undefined || source === '' ? {} : { source })
  }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object')
  return value as Record<string, unknown>
}
