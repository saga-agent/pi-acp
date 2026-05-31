import { RequestError, type ModelInfo, type SessionConfigOption } from '@agentclientprotocol/sdk'
import type { PiRpcProcess } from '../pi-rpc/process.js'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ThinkingState = {
  availableModes: Array<{
    id: ThinkingLevel
    name: string
    description?: string | null
  }>
  currentModeId: ThinkingLevel
}

export type ModelState = {
  availableModels: ModelInfo[]
  currentModelId: string
} | null

export type ConfigStateOverride = {
  state?: any | null
  availableModels?: any | null
  modelState?: ModelState
  thinkingState?: ThinkingState
  currentModelId?: string | null
  currentThinkingLevel?: ThinkingLevel | null
}

export const MODEL_CONFIG_ID = 'model'
export const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

export function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
}

function formatThinkingLevelName(level: ThinkingLevel): string {
  if (level === 'xhigh') return 'Extra high'
  return level.slice(0, 1).toUpperCase() + level.slice(1)
}

export function toSessionConfigOptions(modelState: ModelState, thinkingState: ThinkingState): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = []

  if (modelState?.availableModels.length) {
    configOptions.push({
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelState.currentModelId,
      options: modelState.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  configOptions.push({
    id: THOUGHT_LEVEL_CONFIG_ID,
    name: 'Thought Level',
    category: 'thought_level',
    type: 'select',
    currentValue: thinkingState.currentModeId,
    options: thinkingState.availableModes.map(mode => ({
      value: mode.id,
      name: formatThinkingLevelName(mode.id),
      description: mode.description ?? null
    }))
  })

  return configOptions
}

export async function getSessionConfigOptions(
  proc: PiRpcProcess,
  pre?: ConfigStateOverride
): Promise<SessionConfigOption[]> {
  const models = pre?.modelState ?? (await getModelState(proc, pre))
  const thinking = pre?.thinkingState ?? (await getThinkingState(proc, pre))
  return toSessionConfigOptions(models, thinking)
}

export async function resolveModelSelection(
  proc: PiRpcProcess,
  requestedModelId: string
): Promise<{ provider: string; modelId: string; currentModelId: string }> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [p, ...rest] = requestedModelId.split('/')
    provider = p
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  return {
    provider,
    modelId,
    currentModelId: `${provider}/${modelId}`
  }
}

export async function getThinkingState(proc: PiRpcProcess, pre?: ConfigStateOverride): Promise<ThinkingState> {
  let current: ThinkingLevel = pre?.currentThinkingLevel ?? 'medium'

  if (!pre?.currentThinkingLevel) {
    const state =
      pre?.state ??
      (await (async () => {
        try {
          return (await proc.getState()) as any
        } catch {
          return null
        }
      })())

    const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
    if (tl && isThinkingLevel(tl)) current = tl
  }

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

export async function getModelState(proc: PiRpcProcess, pre?: ConfigStateOverride): Promise<ModelState> {
  let availableModels: ModelInfo[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies ModelInfo
    })
    .filter(Boolean) as ModelInfo[]

  let currentModelId: string | null = pre?.currentModelId ?? null

  if (!currentModelId) {
    const state =
      pre?.state ??
      (await (async () => {
        try {
          return (await proc.getState()) as any
        } catch {
          return null
        }
      })())

    const model = state?.model
    if (model && typeof model === 'object') {
      const provider = String((model as any).provider ?? '').trim()
      const id = String((model as any).id ?? '').trim()
      if (provider && id) currentModelId = `${provider}/${id}`
    }
  }

  if (!availableModels.length && !currentModelId) return null

  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  if (currentModelId && !availableModels.some(model => model.modelId === currentModelId)) {
    availableModels = [{ modelId: currentModelId, name: currentModelId, description: null }, ...availableModels]
  }

  return {
    availableModels,
    currentModelId
  }
}
