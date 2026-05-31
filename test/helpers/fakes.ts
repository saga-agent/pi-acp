import type { AgentSideConnection, TerminalOutputResponse, WaitForTerminalExitResponse } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import { acpSchema } from './acp-schema.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]
type TerminalHandleLike = Awaited<ReturnType<AgentSideConnection['createTerminal']>>

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly readTextFileRequests: unknown[] = []
  readonly writeTextFileRequests: unknown[] = []
  readonly createTerminalRequests: unknown[] = []
  terminalId = 'terminal-1'
  terminalOutput: TerminalOutputResponse = { output: '', truncated: false }
  terminalExitStatus: WaitForTerminalExitResponse = { exitCode: 0, signal: null }
  terminalKillCount = 0
  terminalReleaseCount = 0
  readTextFileContent = ''

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    acpSchema.sessionNotification.parse(msg)
    this.updates.push(msg)
  }

  async readTextFile(params: unknown): Promise<{ content: string }> {
    this.readTextFileRequests.push(params)
    return { content: this.readTextFileContent }
  }

  async writeTextFile(params: unknown): Promise<Record<string, never>> {
    this.writeTextFileRequests.push(params)
    return {}
  }

  async createTerminal(params: unknown): Promise<TerminalHandleLike> {
    this.createTerminalRequests.push(params)
    return {
      id: this.terminalId,
      currentOutput: async () => this.terminalOutput,
      waitForExit: async () => this.terminalExitStatus,
      kill: async () => {
        this.terminalKillCount += 1
        return {}
      },
      release: async () => {
        this.terminalReleaseCount += 1
        return {}
      }
    } as TerminalHandleLike
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  abortCount = 0
  commands: Array<{ name: string }> = []

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getCommands(): Promise<any> {
    return { commands: this.commands }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
