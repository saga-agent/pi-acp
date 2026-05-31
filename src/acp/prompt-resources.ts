import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentSideConnection, ClientCapabilities, ContentBlock } from '@agentclientprotocol/sdk'
import type { BridgeRpcHandler } from '../pi-rpc/bridge-rpc.js'
import { supportsClientFsRead } from './client-fs.js'

const MAX_FETCHED_PROMPT_RESOURCE_BYTES = 5 * 1024 * 1024
const FETCH_PROMPT_RESOURCE_TIMEOUT_MS = 15_000

export type PromptResourceLink = {
  type: 'resource_link'
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export type PromptResourceReadResult = {
  contents: Array<{
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }>
}

export class PromptResourceStore {
  private readonly resourcesBySession = new Map<string, PromptResourceLink[]>()

  setSessionResourceLinks(sessionId: string, resources: PromptResourceLink[]): void {
    if (resources.length === 0) {
      this.resourcesBySession.delete(sessionId)
      return
    }

    this.resourcesBySession.set(sessionId, cloneResources(resources))
  }

  getSessionResourceLinks(sessionId: string): PromptResourceLink[] {
    return cloneResources(this.resourcesBySession.get(sessionId) ?? [])
  }

  clearSessionResourceLinks(sessionId: string): void {
    this.resourcesBySession.delete(sessionId)
  }

  findSessionResourceLink(sessionId: string, uri: string): PromptResourceLink | null {
    const found = (this.resourcesBySession.get(sessionId) ?? []).find(resource => resource.uri === uri)
    return found ? { ...found } : null
  }
}

export function normalizePromptResourceLinks(blocks: ContentBlock[]): PromptResourceLink[] {
  const out: PromptResourceLink[] = []

  for (const block of blocks) {
    const raw = block as Record<string, unknown>
    if (raw.type !== 'resource_link') continue

    const uri = requiredString(raw.uri)
    if (!uri) continue

    out.push({
      type: 'resource_link',
      uri,
      name: requiredString(raw.name) || fallbackResourceName(uri),
      ...(optionalString(raw.title) === undefined ? {} : { title: optionalString(raw.title) }),
      ...(optionalString(raw.description) === undefined ? {} : { description: optionalString(raw.description) }),
      ...(optionalString(raw.mimeType) === undefined ? {} : { mimeType: optionalString(raw.mimeType) }),
      ...(optionalNonNegativeInteger(raw.size) === undefined ? {} : { size: optionalNonNegativeInteger(raw.size) })
    })
  }

  return out
}

export function createPromptResourceBridgeHandler(options: {
  conn: AgentSideConnection
  clientCapabilities: ClientCapabilities | null | undefined
  getSessionId: () => string | null | undefined
  promptResourceStore?: PromptResourceStore | null
}): BridgeRpcHandler {
  return async (method, params) => {
    const sessionId = options.getSessionId()
    if (!sessionId) throw new Error('ACP session id is not available yet')

    if (method === 'resource/list_prompt_resource_links') {
      return {
        resources: options.promptResourceStore?.getSessionResourceLinks(sessionId) ?? []
      }
    }

    if (method === 'resource/read_prompt_resource') {
      const uri = normalizeReadPromptResourceParams(params).uri
      const link = options.promptResourceStore?.findSessionResourceLink(sessionId, uri)
      if (!link) throw new Error(`Prompt resource is not available in the active turn: ${uri}`)

      const path = filePathFromUri(uri)
      if (!path) {
        const fetched = await readFetchablePromptResource(uri, link)
        if (fetched) return { contents: [fetched] } satisfies PromptResourceReadResult
        throw new Error(`Unsupported prompt resource URI: ${uri}`)
      }

      const text = supportsClientFsRead(options.clientCapabilities)
        ? await readPromptResourceThroughClientFs(options.conn, sessionId, path)
        : readFileSync(path, 'utf8')

      return {
        contents: [
          {
            uri,
            mimeType: link.mimeType ?? 'text/plain',
            text
          }
        ]
      } satisfies PromptResourceReadResult
    }

    throw new Error(`Unsupported ACP bridge method: ${method}`)
  }
}

function normalizeReadPromptResourceParams(params: unknown): { uri: string } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object')
  const uri = requiredString((params as Record<string, unknown>).uri)
  if (!uri) throw new Error('uri must be a non-empty string')
  return { uri }
}

async function readPromptResourceThroughClientFs(
  conn: AgentSideConnection,
  sessionId: string,
  path: string
): Promise<string> {
  const result = await conn.readTextFile({ sessionId, path })
  const content = (result as { content?: unknown } | null)?.content
  if (typeof content !== 'string') throw new Error('ACP client returned invalid readTextFile response')
  return content
}

async function readFetchablePromptResource(
  uri: string,
  link: PromptResourceLink
): Promise<PromptResourceReadResult['contents'][number] | null> {
  const protocol = fetchableProtocol(uri)
  if (!protocol) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_PROMPT_RESOURCE_TIMEOUT_MS)

  try {
    const response = await fetch(uri, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FETCHED_PROMPT_RESOURCE_BYTES) {
      throw new Error(`prompt resource exceeds ${MAX_FETCHED_PROMPT_RESOURCE_BYTES} bytes`)
    }

    const mimeType = normalizeMimeType(response.headers.get('content-type') ?? link.mimeType)
    const base = {
      uri,
      ...(mimeType ? { mimeType } : {})
    }

    if (isTextMimeType(mimeType)) return { ...base, text: bytes.toString('utf8') }
    return { ...base, blob: bytes.toString('base64') }
  } catch (err) {
    if ((err as { name?: unknown })?.name === 'AbortError') {
      throw new Error(`Timed out reading prompt resource URI: ${uri}`)
    }

    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to read prompt resource URI: ${uri}: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

function filePathFromUri(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return null
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function fetchableProtocol(uri: string): string | null {
  try {
    const protocol = new URL(uri).protocol
    return protocol === 'data:' || protocol === 'http:' || protocol === 'https:' ? protocol : null
  } catch {
    return null
  }
}

function normalizeMimeType(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const mimeType = value.split(';', 1)[0]!.trim().toLowerCase()
  return mimeType || undefined
}

function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/yaml' ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  )
}

function fallbackResourceName(uri: string): string {
  try {
    const url = new URL(uri)
    const name = url.pathname.split('/').filter(Boolean).pop()
    return name || uri
  } catch {
    return uri
  }
}

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function cloneResources(resources: PromptResourceLink[]): PromptResourceLink[] {
  return resources.map(resource => ({ ...resource }))
}
