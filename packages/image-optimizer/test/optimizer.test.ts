import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import sharp from "sharp"
import { ImageCache } from "../src/cache.js"
import { compress, type Image, ImageConstraintError } from "../src/compress.js"
import { parseOptions, policyFor } from "../src/config.js"
import { optimizeRequest, optimizeResult } from "../src/hooks.js"
import { decode, type FileContent, Optimizer } from "../src/optimizer.js"

let directory: string
let screenshot: Buffer
let noise: Buffer
beforeAll(async () => {
  const temporaryRoot = join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  directory = await mkdtemp(join(temporaryRoot, "image-test-"))
  // Render actual text and thin lines, rather than only blank solid images.
  const svg = `<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#171923"/>${Array.from({ length: 24 }, (_, i) => `<text x="20" y="${30 + i * 30}" font-family="monospace" font-size="20" fill="${i % 2 ? "#80ff99" : "#eeeeee"}">const item${i} = await readFile("screenshot.png"); // 1234567890</text><path d="M900 ${i * 30} H1180" stroke="#ff7777"/>`).join("")}</svg>`
  screenshot = await sharp(Buffer.from(svg)).png().toBuffer()
  const pixels = Buffer.alloc(800 * 600 * 3)
  let state = 42
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    pixels[i] = state >>> 24
  }
  noise = await sharp(pixels, { raw: { width: 800, height: 600, channels: 3 } })
    .png()
    .toBuffer()
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

const file = (image: Image): FileContent => ({
  type: "file",
  name: "shot.png",
  mime: image.mime,
  uri: `data:${image.mime};base64,${image.data.toString("base64")}`,
})
const options = parseOptions({})
const webp = policyFor(options, { providerID: "openai", id: "vision" })

async function optimizer(name: string, capacity = 32 * 1024 * 1024) {
  const cache = new ImageCache(join(directory, name), capacity)
  await cache.init()
  return { cache, optimizer: new Optimizer(cache) }
}

describe("encoding", () => {
  test("compresses text screenshots while preserving resolution and readable contrast", async () => {
    const result = await compress({ data: screenshot, mime: "image/png" }, { ...webp, formats: ["webp"] })
    expect(result.mime).toBe("image/webp")
    const metadata = await sharp(result.data).metadata()
    expect([metadata.width, metadata.height]).toEqual([1200, 800])
    expect(result.data.length).toBeLessThan(screenshot.length)
    const source = await sharp(screenshot).removeAlpha().raw().toBuffer()
    const decoded = await sharp(result.data).removeAlpha().raw().toBuffer()
    const mse = source.reduce((sum, value, index) => sum + (value - decoded[index]!) ** 2, 0) / source.length
    expect(10 * Math.log10(255 ** 2 / mse)).toBeGreaterThan(30)
  })

  test("recompresses an already-WebP image over the target", async () => {
    const original = await sharp(noise).webp({ lossless: true }).toBuffer()
    const result = await compress({ data: original, mime: "image/webp" }, { ...webp, targetBytes: 100_000 })
    expect(result.data.length).toBeLessThan(original.length)
    expect((await sharp(result.data).metadata()).width).toBe(800)
  })

  test("keeps small WebP byte-for-byte and preserves alpha", async () => {
    const original = await sharp({
      create: { width: 48, height: 48, channels: 4, background: { r: 20, g: 50, b: 80, alpha: 0.3 } },
    })
      .webp()
      .toBuffer()
    const result = await compress({ data: original, mime: "image/webp" }, webp)
    expect(result.data.equals(original)).toBe(true)
    const compatible = await compress(result, { ...webp, formats: ["jpeg", "png"] })
    expect(compatible.mime).toBe("image/png")
    expect((await sharp(compatible.data).metadata()).hasAlpha).toBe(true)
    expect((await sharp(compatible.data).raw().toBuffer())[3]).toBe((await sharp(original).raw().toBuffer())[3])
    expect((await compress(result, { ...webp, formats: ["jpeg", "webp"] })).mime).toBe("image/webp")
  })

  test("supports explicit resizing and hard base64/dimension limits", async () => {
    const result = await compress(
      { data: noise, mime: "image/png" },
      { ...webp, targetBytes: 60_000, maxBase64Bytes: 80_000, maxDimension: 600, allowResize: true, minDimension: 100 },
    )
    expect(result.data.toString("base64").length).toBeLessThanOrEqual(80_000)
    expect((await sharp(result.data).metadata()).width).toBeLessThanOrEqual(600)
  })

  test("reports impossible hard constraints instead of returning a rejected image", async () => {
    await expect(compress({ data: noise, mime: "image/png" }, { ...webp, maxBytes: 10 })).rejects.toBeInstanceOf(
      ImageConstraintError,
    )
    await expect(
      compress({ data: screenshot, mime: "image/png" }, { ...webp, maxDimension: 100 }),
    ).rejects.toBeInstanceOf(ImageConstraintError)
  })

  test("does not silently flatten animated WebP", async () => {
    const frames = Buffer.concat([Buffer.alloc(40 * 40 * 3, 120), Buffer.alloc(40 * 40 * 3, 240)])
    const animated = await sharp(frames, { raw: { width: 40, height: 80, channels: 3, pageHeight: 40 } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2)
    const result = await compress({ data: animated, mime: "image/webp" }, webp)
    expect(result.data.equals(animated)).toBe(true)
    await expect(compress(result, { ...webp, formats: ["jpeg", "png"] })).rejects.toBeInstanceOf(ImageConstraintError)
  })
})

describe("hooks and cache", () => {
  test("updates native read structured output and content together without mutating its input", async () => {
    const { optimizer: engine } = await optimizer("result")
    const image = file({ data: screenshot, mime: "image/png" })
    const original = {
      output: { type: "file", encoding: "base64", mime: image.mime, content: screenshot.toString("base64") },
      content: [{ type: "text" as const, text: "Image read successfully" }, image],
      metadata: { truncated: false, custom: 42 },
    }
    const result = await optimizeResult(original, engine, { ...webp, formats: ["webp"] })
    expect(result.metadata).toEqual(original.metadata)
    expect(result.content![0]).toEqual(original.content[0])
    const converted = (result.content as FileContent[])[1]!
    expect(converted.mime).toBe("image/webp")
    expect(result.output).toEqual({
      ...original.output,
      mime: converted.mime,
      content: decode(converted)!.data.toString("base64"),
    })
    expect(original.content[1]).toBe(image)
    expect(original.output.mime).toBe("image/png")
  })

  test("switches providers from the original pixels after cache restart, leaves history untouched", async () => {
    const { optimizer: first } = await optimizer("restart")
    const input = file({ data: screenshot, mime: "image/png" })
    const encoded = await first.file(input, { ...webp, formats: ["webp"] })
    const { optimizer: second } = await optimizer("restart")
    const event = {
      model: { providerID: "gateway", id: "model" },
      system: [],
      options: {},
      messages: [
        {
          role: "tool",
          content: [{ type: "tool-result", id: "call-1", name: "read", result: { type: "content", value: [encoded] } }],
        },
      ],
    } as unknown as SessionRequest
    const persisted = JSON.stringify(event.messages)
    const originalMessages = event.messages.slice()
    await optimizeRequest(event, second, options)
    expect(JSON.stringify(originalMessages)).toBe(persisted)
    const result = event.messages[0]!.content[0]!
    if (result.type !== "tool-result" || result.result.type !== "content") throw new Error("Unexpected result")
    const actual = result.result.value[0] as FileContent
    const direct = await compress({ data: screenshot, mime: "image/png" }, policyFor(options, event.model))
    expect(decode(actual)!.data.equals(direct.data)).toBe(true)
    expect(actual.mime).not.toBe("image/webp")
    const once = JSON.stringify(event.messages)
    await optimizeRequest(event, second, options)
    expect(JSON.stringify(event.messages)).toBe(once)
  })

  test("preserves PDFs, text, external URLs, and other tools", async () => {
    const { optimizer: engine } = await optimizer("passthrough")
    const result = {
      content: [
        { type: "text" as const, text: "hello" },
        { type: "file" as const, mime: "application/pdf", uri: "data:application/pdf;base64,cGRm" },
      ],
    }
    expect(await optimizeResult(result, engine, webp)).toBe(result)
    const remote: FileContent = { type: "file", mime: "image/webp", uri: "https://example.invalid/image.webp" }
    expect(await engine.file(remote, webp)).toBe(remote)
    const event = {
      model: { providerID: "openai", id: "vision" },
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              name: "other",
              id: "a",
              result: { type: "content", value: [file({ data: screenshot, mime: "image/png" })] },
            },
          ],
        },
      ],
    } as unknown as SessionRequest
    const original = JSON.stringify(event)
    await optimizeRequest(event, engine, options)
    expect(JSON.stringify(event)).toBe(original)
  })

  test("falls back on corrupt images, while enforcing hard limits", async () => {
    const { optimizer: engine } = await optimizer("bad")
    const input = file({ data: Buffer.from("not a png"), mime: "image/png" })
    expect(await engine.file(input, webp)).toBe(input)
    await expect(engine.file(input, { ...webp, maxBytes: 1 })).rejects.toBeInstanceOf(ImageConstraintError)
  })

  test("disk cache evicts entries within its byte budget", async () => {
    const { cache } = await optimizer("bounded", 2200)
    for (let i = 0; i < 6; i++) {
      const image = { data: Buffer.alloc(256, i), mime: "image/png" }
      await cache.put(image, "policy", image)
    }
    const files = await readdir(join(directory, "bounded"))
    const sizes = await Promise.all(files.map((name) => stat(join(directory, "bounded", name))))
    expect(sizes.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThanOrEqual(2200)
    expect(files.length).toBeLessThan(6)
  })
})

test("configuration uses ordered provider/model rules and rejects typos", () => {
  const config = parseOptions({
    rules: [
      { provider: "gateway*", formats: ["webp", "png"] },
      { provider: "gateway", model: "legacy-*", formats: ["jpeg", "png"], maxBytes: 500_000 },
    ],
  })
  expect(policyFor(config, { providerID: "unknown", id: "gpt-something" }).formats).toEqual(["jpeg", "png"])
  expect(policyFor(config, { providerID: "gateway", id: "new" }).formats[0]).toBe("webp")
  expect(policyFor(config, { providerID: "gateway", id: "legacy-v1" }).maxBytes).toBe(500_000)
  expect(() => parseOptions({ targetByte: 10 })).toThrow()
  expect(() => parseOptions({ quality: 80, minQuality: 90 })).toThrow()
})
