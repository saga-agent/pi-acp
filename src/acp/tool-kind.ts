import type { ToolKind } from '@agentclientprotocol/sdk'

const searchToolNames = new Set(['find', 'glob', 'grep', 'ls', 'rg', 'ripgrep', 'search'])
const deleteToolNames = new Set(['delete', 'delete_file', 'remove', 'remove_file', 'rm', 'unlink'])
const moveToolNames = new Set(['move', 'move_file', 'mv', 'rename', 'rename_file'])
const fetchToolNames = new Set(['fetch', 'web_fetch', 'http_get', 'get_url', 'curl', 'wget'])
const thinkToolNames = new Set(['think', 'thinking', 'reason', 'reasoning', 'plan'])
const switchModeToolNames = new Set(['switch_mode', 'set_mode', 'change_mode'])

export function toToolKind(toolName: string, terminalBackedToolNames?: Set<string>): ToolKind {
  if (terminalBackedToolNames?.has(toolName)) return 'execute'

  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      if (searchToolNames.has(toolName)) return 'search'
      if (deleteToolNames.has(toolName)) return 'delete'
      if (moveToolNames.has(toolName)) return 'move'
      if (fetchToolNames.has(toolName)) return 'fetch'
      if (thinkToolNames.has(toolName)) return 'think'
      if (switchModeToolNames.has(toolName)) return 'switch_mode'
      return 'other'
  }
}
