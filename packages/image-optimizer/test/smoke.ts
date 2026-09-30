// Real OpenCode -> read -> plugin -> local mock API. No external model calls.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import sharp from "sharp"

const temporaryRoot = join(tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
const root = await mkdtemp(join(temporaryRoot, "image-smoke-"))
const project = join(root, "project")
await mkdir(project)
const png = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="100%" height="100%" fill="white"/>${Array.from({ length: 35 }, (_, i) => `<text x="20" y="${30 + i * 32}" font-size="24">Read image ${i}: preserve text, 0123456789</text>`).join("")}</svg>`,
  ),
)
  .png()
  .toBuffer()
await writeFile(join(project, "sample.png"), png)
const images: { mime: string; bytes: number; width?: number; height?: number }[] = []
let toolRequested = false
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: unknown[]; tools?: unknown[] }
    const serialized = JSON.stringify(body.messages)
    const matches = [...serialized.matchAll(/data:(image\/[a-z]+);base64,([a-zA-Z0-9+/=]+)/g)]
    for (const match of matches) {
      const bytes = Buffer.from(match[2]!, "base64")
      const meta = await sharp(bytes).metadata()
      images.push({ mime: match[1]!, bytes: bytes.length, width: meta.width, height: meta.height })
    }
    const read = !toolRequested && !!body.tools?.length && serialized.includes("SMOKE_READ_IMAGE")
    if (read) toolRequested = true
    const delta = read
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_image",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: join(project, "sample.png") }) },
            },
          ],
        }
      : { role: "assistant", content: "SMOKE_OK" }
    const chunk = (value: object) =>
      `data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: "vision", ...value })}\n\n`
    return new Response(
      chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

try {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "image-smoke/vision",
    plugins: [
      {
        package: process.env.IMAGE_SMOKE_PLUGIN_DIRECTORY ?? resolve(dirname(import.meta.path), ".."),
        options: { formats: ["webp"], cacheDirectory: join(root, "image-cache"), debug: true },
      },
    ],
    providers: {
      "image-smoke": {
        env: ["IMAGE_SMOKE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-test" },
        models: { vision: { capabilities: { tools: true, input: ["text", "image"], output: ["text"] } } },
      },
    },
    snapshots: false,
  }
  await writeFile(join(project, "opencode.json"), JSON.stringify(config))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DB: join(root, "smoke.db"),
  }
  delete env.OPENCODE_CONFIG_CONTENT
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_DIR
  env.IMAGE_SMOKE_API_KEY = "local-test"
  env.PWD = project
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  const child = Bun.spawn(
    [
      "opencode",
      "run",
      "--standalone",
      "--print-logs",
      "--log-level",
      "debug",
      "--auto",
      "--format",
      "json",
      "--model",
      "image-smoke/vision",
      "SMOKE_READ_IMAGE: read sample.png with the read tool.",
    ],
    { cwd: project, env, stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 90_000)
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  if (
    exit !== 0 ||
    images.length === 0 ||
    images.some((image) => image.mime !== "image/webp" || image.width !== 1600 || image.height !== 1200)
  ) {
    const redacted = stdout.replace(/[a-zA-Z0-9+/=]{300,}/g, "[image bytes]")
    throw new Error(`Smoke failed: exit=${exit}, images=${JSON.stringify(images)}\n${redacted}\n${stderr}`)
  }
  console.log(
    JSON.stringify({ opencode: "real standalone CLI", originalBytes: png.length, receivedImages: images }, null, 2),
  )
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
