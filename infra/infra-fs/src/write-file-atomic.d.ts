declare module 'write-file-atomic' {
  interface WriteOptions { encoding?: BufferEncoding; mode?: number }
  interface Writer {
    (path: string, data: string, options?: WriteOptions): Promise<void>
    sync(path: string, data: string, options?: WriteOptions): void
  }
  const writer: Writer
  export default writer
}
