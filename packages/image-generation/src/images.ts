import { z } from "zod"
import type { ImageProvider } from "./provider.js"

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().optional(),
        url: z.string().optional(),
        revised_prompt: z.string().optional(),
      }),
    )
    .min(1)
    .max(4),
})

export interface GeneratedImage {
  bytes: Buffer
  mime: string
  extension: string
  revisedPrompt?: string
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("Image API returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error(`Image API response exceeds the ${limit}-byte limit`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function identify(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", extension: "png" }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", extension: "webp" }
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return { mime: "image/gif", extension: "gif" }
  throw new Error("Image API returned unsupported image bytes; expected PNG, JPEG, WebP, or GIF")
}

export async function generateImages(
  provider: ImageProvider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  maxImageBytes: number,
): Promise<GeneratedImage[]> {
  signal.throwIfAborted()
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers,
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Image generation failed: HTTP ${response.status}. Check the endpoint, API key, model ID, and supported image parameters`,
    )
  }
  const raw = await readLimited(response, Math.ceil((maxImageBytes * 4) / 3) * 4 + 1024 * 1024)
  let decoded: unknown
  try {
    decoded = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Image API did not return JSON")
  }
  const parsed = responseSchema.safeParse(decoded)
  if (!parsed.success) throw new Error("Image API must return data[1..4] containing b64_json or url")

  const images: GeneratedImage[] = []
  for (const item of parsed.data.data) {
    signal.throwIfAborted()
    let bytes: Buffer
    if (item.b64_json) {
      if (item.b64_json.length > Math.ceil(maxImageBytes / 3) * 4)
        throw new Error("Generated image exceeds maxImageBytes")
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json) || item.b64_json.length % 4 === 1)
        throw new Error("Image API returned invalid base64")
      bytes = Buffer.from(item.b64_json, "base64")
    } else if (item.url) {
      const url = new URL(item.url)
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Image download URL must use HTTP(S) without credentials")
      // Signed image URLs use their own credentials. Never forward provider headers.
      const download = await fetch(url, { signal, redirect: "error" })
      if (!download.ok) {
        await download.body?.cancel()
        throw new Error(`Image download failed: HTTP ${download.status}`)
      }
      bytes = await readLimited(download, maxImageBytes)
    } else {
      throw new Error("Image API returned an entry without b64_json or url")
    }
    if (bytes.length > maxImageBytes) throw new Error("Generated image exceeds maxImageBytes")
    images.push({ bytes, ...identify(bytes), revisedPrompt: item.revised_prompt })
  }
  return images
}
