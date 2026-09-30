import sharp from "sharp"
import type { Format, Policy } from "./config.js"

export interface Image {
  data: Buffer
  mime: string
}

export class ImageConstraintError extends Error {}

const mimes: Record<Format, string> = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" }

export function byteLimit(policy: Policy) {
  return Math.min(
    policy.maxBytes ?? Infinity,
    policy.maxBase64Bytes === undefined ? Infinity : Math.floor(policy.maxBase64Bytes / 4) * 3,
  )
}

export function assertBytes(image: Image, policy: Policy) {
  if (image.data.length > byteLimit(policy)) throw new ImageConstraintError("Image exceeds configured hard byte limit")
}

export async function compress(source: Image, policy: Policy): Promise<Image> {
  const metadata = await sharp(source.data, { limitInputPixels: 100_000_000 }).metadata()
  const format = metadata.format
  const accepted = policy.formats.some((f) => f === format)
  const width = metadata.autoOrient.width ?? metadata.width!
  const height = metadata.autoOrient.height ?? metadata.height!
  const longest = Math.max(width, height)
  const withinDimensions = longest <= (policy.maxDimension ?? Infinity)
  const withinBytes = source.data.length <= byteLimit(policy)
  if (!width || !height) throw new Error("Image has no dimensions")

  // Never silently flatten animations or rasterize SVG/PDF.
  if ((metadata.pages ?? 1) > 1 || !["webp", "jpeg", "png"].includes(format ?? "")) {
    if (!withinBytes || !withinDimensions || (format === "webp" && !accepted)) {
      throw new ImageConstraintError("Unsupported/animated image cannot satisfy configured image policy")
    }
    return source
  }

  const outputFormat = metadata.hasAlpha ? policy.formats.find((format) => format !== "jpeg") : policy.formats[0]
  if (!outputFormat) {
    throw new ImageConstraintError("JPEG-only policy would discard transparency; allow PNG or WebP")
  }
  if (
    format === outputFormat &&
    withinDimensions &&
    source.data.length <= Math.min(policy.targetBytes, byteLimit(policy))
  )
    return source
  if (!withinDimensions && !policy.allowResize)
    throw new ImageConstraintError("Image exceeds maxDimension; enable allowResize to resize it")

  const target = Math.min(policy.targetBytes, byteLimit(policy))
  let best: Image | undefined = accepted && withinDimensions && withinBytes ? source : undefined
  let scale = Math.min(1, (policy.maxDimension ?? longest) / longest)
  const minimumScale = Math.min(scale, policy.minDimension / longest)
  const qualities: number[] = []
  for (let q = policy.quality; q > policy.minQuality; q -= 4) qualities.push(q)
  qualities.push(policy.minQuality)

  // Each candidate starts with the original bytes, never the previous candidate.
  for (let attempt = 0; attempt < 16; attempt++) {
    let smallestAtScale = Infinity
    for (const quality of outputFormat === "png" ? [policy.quality] : qualities) {
      let pipeline = sharp(source.data, { limitInputPixels: 100_000_000 }).rotate().toColourspace("srgb")
      if (scale < 1)
        pipeline = pipeline.resize({
          width: Math.max(1, Math.floor(width * scale)),
          height: Math.max(1, Math.floor(height * scale)),
          fit: "inside",
          withoutEnlargement: true,
        })
      if (outputFormat === "webp")
        pipeline = pipeline.webp({ quality, alphaQuality: 100, effort: 5, smartSubsample: true })
      if (outputFormat === "jpeg") pipeline = pipeline.jpeg({ quality, chromaSubsampling: "4:4:4" })
      if (outputFormat === "png") pipeline = pipeline.png({ compressionLevel: 9 })
      const data = await pipeline.toBuffer()
      const candidate = { data, mime: mimes[outputFormat] }
      smallestAtScale = Math.min(smallestAtScale, data.length)
      if (data.length <= byteLimit(policy) && (!best || data.length < best.data.length)) best = candidate
      if (data.length <= target) return best!
    }
    if (!policy.allowResize || scale <= minimumScale) break
    const next = Math.max(minimumScale, scale * Math.min(0.85, Math.sqrt(target / smallestAtScale) * 0.95))
    if (next >= scale) break
    scale = next
  }
  if (!best)
    throw new ImageConstraintError("Cannot satisfy hard image limits within the configured quality/resize bounds")
  return best
}
