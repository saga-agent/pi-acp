import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

export type BridgeRpcEndpoint = {
  host: string
  port: number
  token: string
}

export type BridgeRpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown

export type BridgeRpcServer = {
  endpoint: BridgeRpcEndpoint
  close: () => void
}

type BridgeRpcMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
  token?: unknown
}

export async function startBridgeRpcServer(handler: BridgeRpcHandler): Promise<BridgeRpcServer> {
  const host = '127.0.0.1'
  const token = randomUUID()
  const server = createServer(socket => handleSocket(socket, token, handler))
  server.unref?.()

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      server.off('error', onError)
      server.off('listening', onListening)
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    closeServer(server)
    throw new Error('ACP bridge RPC server did not bind to a TCP port')
  }

  return {
    endpoint: { host, port: address.port, token },
    close: () => closeServer(server)
  }
}

function handleSocket(socket: Socket, token: string, handler: BridgeRpcHandler): void {
  socket.unref?.()
  let buffer = ''

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) void handleLine(socket, line, token, handler)
    }
  })
}

async function handleLine(socket: Socket, line: string, token: string, handler: BridgeRpcHandler): Promise<void> {
  let message: BridgeRpcMessage
  try {
    message = JSON.parse(line) as BridgeRpcMessage
  } catch {
    write(socket, { id: null, error: { message: 'Invalid bridge RPC JSON' } })
    return
  }

  const id = message.id ?? null
  if (message.token !== token) {
    write(socket, { id, error: { message: 'Invalid bridge RPC token' } })
    return
  }

  if (typeof message.method !== 'string' || !message.method) {
    write(socket, { id, error: { message: 'Invalid bridge RPC method' } })
    return
  }

  try {
    const result = await handler(message.method, message.params)
    write(socket, { id, result: result ?? {} })
  } catch (err) {
    write(socket, { id, error: { message: err instanceof Error ? err.message : String(err) } })
  }
}

function write(socket: Socket, message: unknown): void {
  socket.write(JSON.stringify(message) + '\n')
}

function closeServer(server: Server): void {
  try {
    server.close()
  } catch {
    // best effort
  }
}
