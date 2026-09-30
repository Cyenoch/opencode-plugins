import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Image } from "./compress.js"

export const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
interface StoredImage {
  base64: string
  mime: string
  hash: string
}
interface Entry {
  source: StoredImage
  variants: Record<string, StoredImage>
}
interface Index {
  bytes: number
  time: number
  hashes: string[]
}
const store = (image: Image): StoredImage => ({
  base64: image.data.toString("base64"),
  mime: image.mime,
  hash: hash(image.data),
})
const restore = (image: StoredImage): Image => ({ data: Buffer.from(image.base64, "base64"), mime: image.mime })

/** Per-location disk LRU. Callers serialize access; atomic writes survive restarts. */
export class ImageCache {
  private entries = new Map<string, Index>()
  private aliases = new Map<string, string>()

  constructor(
    private directory: string,
    private maxBytes: number,
  ) {}

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const key = name.slice(0, -5)
      try {
        const entry = await this.load(key)
        if (entry.source.hash !== key) throw new Error("Invalid cache entry")
        const info = await stat(this.path(key))
        this.index(key, entry, info.size, info.mtimeMs)
      } catch {
        await rm(this.path(key), { force: true })
      }
    }
    await this.prune()
  }

  private path(key: string) {
    return join(this.directory, `${key}.json`)
  }
  private async load(key: string): Promise<Entry> {
    return JSON.parse(await readFile(this.path(key), "utf8"))
  }

  private index(key: string, entry: Entry, bytes: number, time: number) {
    const hashes = [entry.source.hash, ...Object.values(entry.variants).map((value) => value.hash)]
    this.entries.set(key, { bytes, time, hashes })
    for (const value of hashes) this.aliases.set(value, key)
  }

  async find(input: Image, policyKey: string): Promise<{ source: Image; result?: Image }> {
    const key = this.aliases.get(hash(input.data))
    if (!key) return { source: input }
    try {
      const entry = await this.load(key)
      const now = new Date()
      await utimes(this.path(key), now, now)
      this.entries.get(key)!.time = now.getTime()
      return { source: restore(entry.source), result: entry.variants[policyKey] && restore(entry.variants[policyKey]) }
    } catch {
      this.forget(key)
      return { source: input }
    }
  }

  async put(source: Image, policyKey: string, result: Image) {
    const key = hash(source.data)
    let entry: Entry = { source: store(source), variants: {} }
    if (this.entries.has(key)) {
      try {
        entry = await this.load(key)
      } catch {
        this.forget(key)
      }
    }
    entry.variants[policyKey] = store(result)
    const json = JSON.stringify(entry)
    const bytes = Buffer.byteLength(json)
    if (bytes > this.maxBytes) return
    const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, json, { mode: 0o600 })
      await rename(temporary, this.path(key))
    } finally {
      await rm(temporary, { force: true })
    }
    this.index(key, entry, bytes, Date.now())
    await this.prune()
  }

  private forget(key: string) {
    for (const alias of this.entries.get(key)?.hashes ?? []) {
      if (this.aliases.get(alias) === key) this.aliases.delete(alias)
    }
    this.entries.delete(key)
  }

  private async prune() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    const oldest = [...this.entries].sort((a, b) => a[1].time - b[1].time)
    for (const [key, entry] of oldest) {
      if (bytes <= this.maxBytes && this.entries.size <= 512) break
      await rm(this.path(key), { force: true })
      this.forget(key)
      bytes -= entry.bytes
    }
  }
}
