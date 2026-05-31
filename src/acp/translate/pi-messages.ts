import type { ContentBlock } from '@agentclientprotocol/sdk'

export function normalizePiMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export function piMessageContentToAcpBlocks(content: unknown): ContentBlock[] {
  return piContentToAcpBlocks(content)
}

export function piAssistantContentToAcpBlocks(content: unknown): ContentBlock[] {
  return piContentToAcpBlocks(content)
}

function piContentToAcpBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (Array.isArray(content)) {
    return content.flatMap(block => {
      const mapped = toAcpContentBlock(block)
      return mapped ? [mapped] : []
    })
  }
  const block = toAcpContentBlock(content)
  return block ? [block] : []
}

function toAcpContentBlock(value: unknown): ContentBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const raw = value as Record<string, unknown>
  const base = contentBlockBase(raw)

  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' && raw.text
        ? ({ ...base, type: 'text', text: raw.text } as ContentBlock)
        : null

    case 'image':
      return typeof raw.data === 'string' && typeof raw.mimeType === 'string'
        ? ({
            ...base,
            type: 'image',
            data: raw.data,
            mimeType: raw.mimeType,
            ...(optionalNullableString(raw.uri) === undefined ? {} : { uri: optionalNullableString(raw.uri) })
          } as ContentBlock)
        : null

    case 'audio':
      return typeof raw.data === 'string' && typeof raw.mimeType === 'string'
        ? ({ ...base, type: 'audio', data: raw.data, mimeType: raw.mimeType } as ContentBlock)
        : null

    case 'resource_link': {
      const uri = requiredString(raw.uri)
      if (!uri) return null
      return {
        ...base,
        type: 'resource_link',
        uri,
        name: requiredString(raw.name) || fallbackResourceName(uri),
        ...(optionalNullableString(raw.title) === undefined ? {} : { title: optionalNullableString(raw.title) }),
        ...(optionalNullableString(raw.description) === undefined
          ? {}
          : { description: optionalNullableString(raw.description) }),
        ...(optionalNullableString(raw.mimeType) === undefined
          ? {}
          : { mimeType: optionalNullableString(raw.mimeType) }),
        ...(optionalNullableNumber(raw.size) === undefined ? {} : { size: optionalNullableNumber(raw.size) })
      } as ContentBlock
    }

    case 'resource':
      return toEmbeddedResourceBlock(raw, base)

    default:
      return null
  }
}

function toEmbeddedResourceBlock(raw: Record<string, unknown>, base: Record<string, unknown>): ContentBlock | null {
  const resource = raw.resource
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null

  const r = resource as Record<string, unknown>
  const uri = requiredString(r.uri)
  if (!uri) return null

  const mimeType = optionalNullableString(r.mimeType)
  const resourceBase = {
    uri,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...contentMeta(r)
  }

  if (typeof r.text === 'string') {
    return {
      ...base,
      type: 'resource',
      resource: {
        ...resourceBase,
        text: r.text
      }
    } as ContentBlock
  }

  if (typeof r.blob === 'string') {
    return {
      ...base,
      type: 'resource',
      resource: {
        ...resourceBase,
        blob: r.blob
      }
    } as ContentBlock
  }

  return null
}

function contentBlockBase(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...contentMeta(raw),
    ...(isObjectOrNull(raw.annotations) ? { annotations: raw.annotations } : {})
  }
}

function contentMeta(raw: Record<string, unknown>): Record<string, unknown> {
  return isObjectOrNull(raw._meta) ? { _meta: raw._meta } : {}
}

function isObjectOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'object' && value !== undefined && !Array.isArray(value))
}

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function optionalNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

export function normalizePiAssistantText(content: unknown): string {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}
