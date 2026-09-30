import { z } from "zod"

const text = z.string().trim().min(1)
const modelRef = text.refine((value) => {
  const slash = value.indexOf("/")
  return slash > 0 && slash < value.length - 1
}, "Use provider/model; additional slashes belong to the model ID")

const imageSettings = z.object({
  size: text.optional(),
  quality: text.optional(),
  background: z.enum(["auto", "transparent", "opaque"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
})

export const inputSchema = imageSettings
  .extend({
    prompt: text.describe("Detailed description of the image to generate"),
    model: modelRef.optional().describe("Override the configured provider/model; preserve any extra slashes"),
    n: z.number().int().min(1).max(4).default(1),
  })
  .strict()

const providerSchema = z
  .object({
    baseURL: z.url().optional(),
    apiKeyEnv: text.optional(),
    integrationID: text.optional(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.record(z.string(), z.json()).default({}),
  })
  .strict()

export const optionsSchema = z
  .object({
    model: modelRef.optional(),
    outputDir: text.default("generated-images"),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(180_000),
    maxImageBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    defaults: imageSettings.strict().default({}),
    providers: z.record(z.string(), providerSchema).default({}),
  })
  .strict()

export type Options = z.infer<typeof optionsSchema>
export type ImageInput = z.infer<typeof inputSchema>

export function splitModel(reference: string) {
  const valid = modelRef.parse(reference)
  const slash = valid.indexOf("/")
  return { providerID: valid.slice(0, slash), modelID: valid.slice(slash + 1) }
}
