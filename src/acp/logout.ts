import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from './pi-settings.js'

export const PI_LOGOUT_CLEARS = ['stored-auth-json'] as const
export const PI_LOGOUT_DOES_NOT_CLEAR = ['environment-variables', 'models-json-fallback', 'runtime-overrides'] as const
export const PI_AUTH_ENV_VARS = [
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'OPENCODE_API_KEY',
  'KIMI_API_KEY',
  'CLOUDFLARE_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY'
] as const

export const PI_AMBIENT_AUTH_ENV_VARS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION'
] as const

export type PiStoredAuthLogoutResult = {
  authPath: string
  invalidAuthFileCleared: boolean
  removedProviders: string[]
}

export type PiLogoutSupport = {
  supported: boolean
  nonClearableSources: string[]
}

export function getPiAuthPath(): string {
  return join(getAgentDir(), 'auth.json')
}

export function getPiModelsPath(): string {
  return join(getAgentDir(), 'models.json')
}

function providerIdsFromAuthJson(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.keys(value as Record<string, unknown>).sort()
}

export function clearStoredPiAuth(): PiStoredAuthLogoutResult {
  const authPath = getPiAuthPath()
  let invalidAuthFileCleared = false
  let removedProviders: string[] = []

  if (existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, 'utf8')
      const providers = providerIdsFromAuthJson(JSON.parse(raw))
      if (providers) removedProviders = providers
      else invalidAuthFileCleared = true
    } catch {
      invalidAuthFileCleared = true
    }
  }

  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  writeFileSync(authPath, '{}\n', 'utf8')
  try {
    chmodSync(authPath, 0o600)
  } catch {
    // Best effort only; some filesystems ignore chmod.
  }

  return {
    authPath,
    invalidAuthFileCleared,
    removedProviders
  }
}

export function getPiLogoutSupport(): PiLogoutSupport {
  const nonClearableSources = [...detectConfiguredAuthEnv(), ...detectModelsJsonAuth(getPiModelsPath())]

  return {
    supported: nonClearableSources.length === 0,
    nonClearableSources
  }
}

function detectConfiguredAuthEnv(): string[] {
  const direct = PI_AUTH_ENV_VARS.filter(name => hasEnvValue(name)).map(name => `environment:${name}`)
  const ambient: string[] = []

  if (hasEnvValue('AWS_PROFILE')) ambient.push('environment:AWS_PROFILE')
  if (hasEnvValue('AWS_ACCESS_KEY_ID') && hasEnvValue('AWS_SECRET_ACCESS_KEY'))
    ambient.push('environment:AWS_ACCESS_KEY_ID')
  for (const name of [
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE'
  ]) {
    if (hasEnvValue(name)) ambient.push(`environment:${name}`)
  }

  const hasGoogleCredential = hasEnvValue('GOOGLE_APPLICATION_CREDENTIALS')
  const hasGoogleProject = hasEnvValue('GOOGLE_CLOUD_PROJECT') || hasEnvValue('GCLOUD_PROJECT')
  const hasGoogleLocation = hasEnvValue('GOOGLE_CLOUD_LOCATION')
  if (hasGoogleCredential && hasGoogleProject && hasGoogleLocation)
    ambient.push('environment:GOOGLE_APPLICATION_CREDENTIALS')

  return [...direct, ...ambient].sort()
}

function detectModelsJsonAuth(modelsPath: string): string[] {
  if (!existsSync(modelsPath)) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8'))
  } catch {
    return ['models-json:unreadable']
  }

  const providers = (parsed as { providers?: unknown } | null)?.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []

  const sources: string[] = []
  for (const [provider, config] of Object.entries(providers)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
    const apiKey = (config as { apiKey?: unknown }).apiKey
    const source = detectConfigValueAuthSource(provider, apiKey)
    if (source) sources.push(source)
  }

  return sources.sort()
}

function detectConfigValueAuthSource(provider: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  if (trimmed.startsWith('!')) return `models-json-command:${provider}`

  const envNames = configValueEnvVarNames(trimmed)
  if (envNames.length > 0) {
    const configured = envNames.find(name => hasEnvValue(name))
    return configured ? `models-json-env:${provider}:${configured}` : null
  }

  return `models-json-key:${provider}`
}

function configValueEnvVarNames(value: string): string[] {
  const names: string[] = []

  const braced = value.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g) ?? []
  for (const item of braced) names.push(item.slice(2, -1))

  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    names.push(value.slice(1))
  }

  return Array.from(new Set(names))
}

function hasEnvValue(name: string): boolean {
  return typeof process.env[name] === 'string' && process.env[name]!.trim().length > 0
}
