import type { Result } from "@opencode/plugin/promise/tool"
import sharp from "sharp"
import { hash, type ImageCache } from "./cache.js"
import { assertBytes, compress, type Image, ImageConstraintError } from "./compress.js"
import type { Policy } from "./config.js"

type Content = Exclude<NonNullable<Result["content"]>, string>[number]
export type FileContent = Extract<Content, { type: "file" }>

export function decode(file: FileContent): Image | undefined {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mime)) return
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]*={0,2})$/.exec(file.uri)
  if (!match || match[1] !== file.mime) return
  const data = Buffer.from(match[2]!, "base64")
  if (data.toString("base64") !== match[2]) return
  return { data, mime: file.mime }
}

export class Optimizer {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private cache: ImageCache,
    private debug = false,
  ) {}

  // Bound libvips work and serialize cache mutations across parallel read calls.
  file(file: FileContent, policy: Policy): Promise<FileContent> {
    const task = this.queue.then(() => this.process(file, policy))
    this.queue = task.catch(() => {})
    return task
  }

  private async process(file: FileContent, policy: Policy): Promise<FileContent> {
    const input = decode(file)
    if (!input) return file
    const policyKey = hash(JSON.stringify({ version: 1, sharp: sharp.versions, policy }))
    try {
      const cached = await this.cache.find(input, policyKey)
      const source = cached.source
      const result = cached.result ?? (await compress(source, policy))
      if (!cached.result) {
        try {
          await this.cache.put(source, policyKey, result)
        } catch {
          console.warn("[image-optimizer] Cache write failed; using optimized image without caching")
        }
      }
      if (result.mime === input.mime && result.data.equals(input.data)) return file
      if (this.debug)
        console.info(`[image-optimizer] ${input.data.length} -> ${result.data.length} bytes (${result.mime})`)
      const extension = result.mime.split("/")[1]!
      return {
        ...file,
        mime: result.mime,
        uri: `data:${result.mime};base64,${result.data.toString("base64")}`,
        ...(file.name ? { name: `${file.name.replace(/\.[^./\\]+$/, "")}.${extension}` } : {}),
      }
    } catch (error) {
      if (error instanceof ImageConstraintError) throw error
      // Soft failures preserve the original tool result, but never knowingly
      // forward bytes or a format that violates an explicit hard policy.
      assertBytes(input, policy)
      if (!policy.formats.some((format) => `image/${format}` === input.mime) || policy.maxDimension !== undefined) {
        throw new ImageConstraintError(
          "Image optimization failed; cannot verify configured format/dimension constraints",
        )
      }
      console.warn("[image-optimizer] Could not optimize image; keeping original result")
      return file
    }
  }
}
