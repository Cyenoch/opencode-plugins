import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { Result, ToolContext } from "@opencode/plugin/promise/tool"
import { inputSchema, type Options, splitModel } from "./config.js"
import { generateImages } from "./images.js"
import { resolveProvider } from "./provider.js"

export type GenerationContext = Pick<Plugin.Context, "provider" | "integration" | "session">

export async function generate(
  ctx: GenerationContext,
  options: Options,
  raw: unknown,
  context: ToolContext,
): Promise<Result> {
  const input = inputSchema.parse(raw)
  const reference = input.model ?? options.model
  if (!reference) throw new Error("Set the image-generation plugin option model or pass model: provider/model")
  const { providerID, modelID } = splitModel(reference)
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)])
  const provider = await resolveProvider(ctx, options, providerID)
  const session = await ctx.session.get({ sessionID: context.sessionID })
  const outputDir = resolve(session.location.directory, options.outputDir)
  await context.progress({ status: "generating", model: reference })
  const { model: _, ...parameters } = input
  const body = { ...provider.body, ...options.defaults, ...parameters, model: modelID }
  const images = await generateImages(provider, body, signal, options.maxImageBytes)
  signal.throwIfAborted()
  await mkdir(outputDir, { recursive: true })
  const batch = await mkdtemp(join(outputDir, "image-"))
  try {
    const files = []
    for (const [index, image] of images.entries()) {
      const name = `${index + 1}.${image.extension}`
      const path = join(batch, name)
      await writeFile(path, image.bytes, { flag: "wx", signal })
      files.push({ path, name, mime: image.mime, uri: pathToFileURL(path).href, revisedPrompt: image.revisedPrompt })
    }
    signal.throwIfAborted()
    return {
      content: [
        { type: "text", text: JSON.stringify({ model: reference, images: files }, null, 2) },
        ...files.map(({ name, mime, uri }) => ({ type: "file" as const, name, mime, uri })),
      ],
      metadata: { model: reference, files: files.map((file) => file.path) },
    }
  } catch (error) {
    await rm(batch, { recursive: true, force: true })
    throw error
  }
}
