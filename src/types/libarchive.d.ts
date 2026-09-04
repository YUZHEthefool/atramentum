// libarchive.js 无官方类型，手写最小声明（仅用到 RAR 解包路径）
declare module 'libarchive.js' {
  export class Archive {
    /** 指定 worker-bundle.js 地址（需拷到 public 静态目录；wasm 由 worker 相对自身解析） */
    static init(options?: { workerUrl?: string }): unknown
    static open(file: File | Blob, options?: unknown): Promise<Archive>
    /** 解包全部条目，返回嵌套目录树，叶子为 File */
    extractFiles(cb?: (entry: { file: File; path: string }) => void): Promise<Record<string, unknown>>
    hasEncryptedData(): Promise<boolean | null>
    usePassword(password: string): Promise<void>
  }
}
