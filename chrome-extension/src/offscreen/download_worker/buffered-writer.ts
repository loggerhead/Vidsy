// A bounded contiguous write buffer. A seek flushes first, so libav's random
// writes and retrying a range at its original offset remain correct.
export class BufferedWriter {
  private buffer: Uint8Array | undefined;
  private start = 0;
  private length = 0;
  constructor(
    private readonly write: (position: number, bytes: Uint8Array) => void,
    readonly capacity = 512 * 1024,
  ) {}

  writeAt(position: number, bytes: Uint8Array): void {
    if (this.length && position !== this.start + this.length) this.flush();
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.length) this.start = position + offset;
      this.buffer ??= new Uint8Array(this.capacity);
      const count = Math.min(this.capacity - this.length, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + count), this.length);
      this.length += count;
      offset += count;
      if (this.length === this.capacity) this.flush();
    }
  }

  flush(): void {
    if (!this.length || !this.buffer) return;
    this.write(this.start, this.buffer.subarray(0, this.length));
    this.length = 0;
  }

  discard(): void {
    this.length = 0;
  }
}
