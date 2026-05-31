import { StringDecoder } from 'node:string_decoder'

export class JsonlLineReader {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    this.append(text)
  }

  end(): void {
    const tail = this.decoder.end()
    if (tail) this.append(tail)
    if (!this.buffer) return

    const line = this.chompCarriageReturn(this.buffer)
    this.buffer = ''
    this.onLine(line)
  }

  private append(text: string): void {
    this.buffer += text

    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return

      const line = this.chompCarriageReturn(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      this.onLine(line)
    }
  }

  private chompCarriageReturn(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line
  }
}
