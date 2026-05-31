import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acpSchema } from '../helpers/acp-schema.js'

const root = resolve(import.meta.dirname, '../..')

test('ACP stdio subprocess: handles malformed/chunked input and keeps stdout protocol-only', async () => {
  const result = await runInitializeOverStdio()
  assert.equal(result.code, 0)

  const messages = parseStdoutMessages(result.stdout)
  const initializeResponse = messages.find(message => message?.id === 1)
  assert.equal(initializeResponse?.jsonrpc, '2.0')
  acpSchema.initializeResponse.parse(initializeResponse?.result)
  assert.equal(initializeResponse?.result?.protocolVersion, 1)
  assert.equal(initializeResponse?.error, undefined)
})

test('ACP stdio subprocess: session/new keeps spawned pi stdout off ACP stdout', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pi-acp-stdio-'))
  const fakePi = join(tmp, 'fake-pi.js')
  writeFileSync(fakePi, fakePiRpcScript(), { encoding: 'utf8' })
  chmodSync(fakePi, 0o755)

  try {
    const result = await runSessionNewOverStdio(fakePi)
    assert.equal(result.code, 0)

    const messages = parseStdoutMessages(result.stdout)
    const newSessionResponse = messages.find(message => message?.id === 2)
    assert.equal(newSessionResponse?.jsonrpc, '2.0')
    assert.equal(newSessionResponse?.error, undefined)
    acpSchema.newSessionResponse.parse(newSessionResponse?.result)
    assert.equal(newSessionResponse?.result?.sessionId, 'fake-session')
    assert.equal(Object.prototype.hasOwnProperty.call(newSessionResponse?.result ?? {}, 'models'), false)
    assert.equal(newSessionResponse?.result?._meta?.piAcp?.models?.currentModelId, 'test/model')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ACP stdio subprocess: prompt turn stays JSONL and emits session updates before response', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pi-acp-stdio-'))
  const fakePi = join(tmp, 'fake-pi.js')
  writeFileSync(fakePi, fakePiRpcScript(), { encoding: 'utf8' })
  chmodSync(fakePi, 0o755)

  try {
    const result = await runPromptTurnOverStdio(fakePi)
    assert.equal(result.code, 0)

    const messages = parseStdoutMessages(result.stdout)
    const newSessionResponse = messages.find(message => message?.id === 2)
    const promptResponse = messages.find(message => message?.id === 3)
    const promptUpdates = messages.filter(
      message =>
        message?.method === 'session/update' &&
        message?.params?.sessionId === 'fake-session' &&
        message?.params?.update?.sessionUpdate === 'agent_message_chunk'
    )

    assert.equal(newSessionResponse?.result?.sessionId, 'fake-session')
    acpSchema.newSessionResponse.parse(newSessionResponse?.result)
    assert.equal(promptResponse?.jsonrpc, '2.0')
    assert.equal(promptResponse?.error, undefined)
    acpSchema.promptResponse.parse(promptResponse?.result)
    assert.equal(promptResponse?.result?.stopReason, 'end_turn')
    assert.ok(promptUpdates.some(message => message?.params?.update?.content?.text === 'hello from fake pi'))
    for (const message of messages.filter(message => message?.method === 'session/update')) {
      acpSchema.sessionNotification.parse(message.params)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

function parseStdoutMessages(stdout: string): any[] {
  const lines = stdout.split('\n').filter(line => line.length > 0)
  assert.ok(lines.length >= 1)

  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (err) {
      assert.fail(`stdout line ${index + 1} was not JSON: ${line}\n${String(err)}`)
    }
  })
}

function runInitializeOverStdio(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false'
      }
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`initialize over stdio timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 5_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(timeout)
      resolvePromise({ code, stdout, stderr })
    })

    child.stdin.write('not valid json\n')

    const request =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: null, _meta: null }
      }) + '\n'
    const split = Math.floor(request.length / 2)
    child.stdin.write(request.slice(0, split))
    setTimeout(() => {
      child.stdin.end(request.slice(split))
    }, 5)
  })
}

function runSessionNewOverStdio(piCommand: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false',
        PI_ACP_PI_COMMAND: piCommand
      }
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let sessionNewSent = false
    let sessionNewSeen = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`session/new over stdio timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 8_000)

    const cleanup = () => clearTimeout(timeout)
    const finishInput = () => {
      if (sessionNewSeen) return
      sessionNewSeen = true
      child.stdin.end()
    }
    const sendSessionNew = () => {
      if (sessionNewSent) return
      sessionNewSent = true
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: root, mcpServers: [], _meta: null }
        }) + '\n'
      )
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuffer += chunk

      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
        if (!line) continue

        try {
          const message = JSON.parse(line)
          if (message?.id === 1) sendSessionNew()
          if (message?.id === 2) finishInput()
        } catch {
          finishInput()
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', err => {
      cleanup()
      reject(err)
    })
    child.on('exit', code => {
      cleanup()
      resolvePromise({ code, stdout, stderr })
    })

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: null, _meta: null }
      }) + '\n'
    )
  })
}

function runPromptTurnOverStdio(piCommand: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false',
        PI_ACP_PI_COMMAND: piCommand
      }
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let sessionNewSent = false
    let promptSent = false
    let promptSeen = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`prompt turn over stdio timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 8_000)

    const cleanup = () => clearTimeout(timeout)
    const finishInput = () => {
      if (promptSeen) return
      promptSeen = true
      child.stdin.end()
    }
    const sendSessionNew = () => {
      if (sessionNewSent) return
      sessionNewSent = true
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: root, mcpServers: [], _meta: null }
        }) + '\n'
      )
    }
    const sendPrompt = () => {
      if (promptSent) return
      promptSent = true
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: {
            sessionId: 'fake-session',
            prompt: [{ type: 'text', text: 'say hello' }],
            _meta: null
          }
        }) + '\n'
      )
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuffer += chunk

      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
        if (!line) continue

        try {
          const message = JSON.parse(line)
          if (message?.id === 1) sendSessionNew()
          if (message?.id === 2) sendPrompt()
          if (message?.id === 3) finishInput()
        } catch {
          finishInput()
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', err => {
      cleanup()
      reject(err)
    })
    child.on('exit', code => {
      cleanup()
      resolvePromise({ code, stdout, stderr })
    })

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: null, _meta: null }
      }) + '\n'
    )
  })
}

function fakePiRpcScript(): string {
  return `#!/usr/bin/env node
process.stdout.write('fake pi human prelude on stdout\\n')
process.stderr.write('fake pi diagnostic on stderr\\n')

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\\n')
    if (!line.trim()) continue
    handle(line)
  }
})

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  const type = message.type
  let data = {}
  if (type === 'get_state') {
    data = {
      sessionId: 'fake-session',
      sessionFile: process.cwd() + '/fake-session.jsonl',
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'model' }
    }
  } else if (type === 'get_available_models') {
    data = { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
  } else if (type === 'get_commands') {
    data = { commands: [] }
  } else if (type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello from fake pi' }
    }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'turn_end' }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n')
  }

  process.stdout.write(JSON.stringify({
    type: 'response',
    id: message.id,
    command: type,
    success: true,
    data
  }) + '\\n')
}
`
}
