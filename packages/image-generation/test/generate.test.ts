import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type TestContext, test } from "node:test"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { optionsSchema } from "../src/config.js"
import { type GenerationContext, generate } from "../src/generate.js"
import plugin from "../src/index.js"
import { resolveProvider } from "../src/provider.js"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
  "base64",
)

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handle)
  await new Promise<void>((done) => instance.listen(0, "127.0.0.1", done))
  t.after(
    () =>
      new Promise<void>((done, reject) => {
        instance.close((error) => (error ? reject(error) : done()))
        instance.closeAllConnections()
      }),
  )
  const address = instance.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

async function fixture(t: TestContext, baseURL: string) {
  const directory = await mkdtemp(join(tmpdir(), "image-plugin-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = {
    provider: { list: async () => ({ data: [{ id: "gateway", settings: { baseURL }, integrationID: "shared-key" }] }) },
    integration: {
      connection: {
        active: async (id: string) => {
          assert.equal(id, "shared-key")
          return { id: "test" }
        },
        resolve: async () => ({ type: "key", key: "test-secret" }),
      },
    },
    session: { get: async () => ({ location: { directory } }) },
  } as unknown as GenerationContext
  const context = {
    sessionID: "session-test",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext
  const options = optionsSchema.parse({ model: "gateway/gpt-image-2.5-flare", timeoutMs: 5_000 })
  return { ctx, context, options, directory }
}

test("V2 registration generates and attaches images in the executing session directory", async (t) => {
  const requests: { path?: string; auth?: string; body: Record<string, unknown> }[] = []
  const url = await server(t, (req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64"), revised_prompt: "Revised" }] }))
    })
  })
  const f = await fixture(t, `${url}/v1/`)
  let registered: Info | undefined
  await plugin.setup({
    ...f.ctx,
    options: { ...f.options, defaults: { quality: "high" } },
    tool: {
      transform: async (callback: (editor: { add: (tool: Info) => void }) => void) =>
        callback({ add: (tool) => (registered = tool) }),
    },
  } as unknown as Plugin.Context)
  assert.ok(registered)
  assert.equal(registered.name, "generate_image")
  const result = await registered.execute(
    { prompt: "Draw an otter", model: "gateway/gpt-image-2.5-flare/sunburst" },
    f.context,
  )
  assert.deepEqual(requests, [
    {
      path: "/v1/images/generations",
      auth: "Bearer test-secret",
      body: {
        model: "gpt-image-2.5-flare/sunburst",
        prompt: "Draw an otter",
        quality: "high",
        n: 1,
      },
    },
  ])
  assert.ok(Array.isArray(result.content))
  const file = result.content.find((part) => part.type === "file")
  assert.ok(file && file.type === "file")
  assert.equal(file.mime, "image/png")
  assert.ok(fileURLToPath(file.uri).startsWith(join(f.directory, "generated-images")))
  assert.deepEqual(await readFile(fileURLToPath(file.uri)), png)
  assert.match(JSON.stringify(result.content), /Revised/)
  assert.doesNotMatch(JSON.stringify(result), /test-secret/)
})

test("URL results are downloaded without forwarding provider credentials", async (t) => {
  let auth: string | undefined = "not-called"
  const download = await server(t, (req, res) => {
    auth = req.headers.authorization
    res.end(png)
  })
  const url = await server(t, (_req, res) => res.end(JSON.stringify({ data: [{ url: `${download}/signed.png` }] })))
  const f = await fixture(t, url)
  await generate(f.ctx, f.options, { prompt: "Otter" }, f.context)
  assert.equal(auth, undefined)
})

test("HTTP failures omit raw server secrets and are not retried", async (t) => {
  let calls = 0
  const url = await server(t, (_req, res) => {
    calls++
    res.writeHead(401)
    res.end("test-secret prompt contents")
  })
  const f = await fixture(t, url)
  await assert.rejects(generate(f.ctx, f.options, { prompt: "Otter" }, f.context), (error: Error) => {
    assert.match(error.message, /HTTP 401/)
    assert.doesNotMatch(error.message, /test-secret|prompt contents/)
    return true
  })
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(f.directory), [])
})

test("cancellation aborts an in-flight request without saving files", async (t) => {
  let received!: () => void
  const pending = new Promise<void>((resolve) => (received = resolve))
  const url = await server(t, () => received())
  const f = await fixture(t, url)
  const controller = new AbortController()
  const result = generate(f.ctx, f.options, { prompt: "Otter" }, { ...f.context, signal: controller.signal })
  const rejected = assert.rejects(result, /cancelled/)
  await pending
  controller.abort(new Error("cancelled"))
  await rejected
  assert.deepEqual(await readdir(f.directory), [])
})

test("timeout stops a stalled image request", async (t) => {
  const url = await server(t, () => {})
  const f = await fixture(t, url)
  await assert.rejects(generate(f.ctx, { ...f.options, timeoutMs: 30 }, { prompt: "Otter" }, f.context), {
    name: "TimeoutError",
  })
})

test("oversized and non-image output is rejected before saving", async (t) => {
  for (const [bytes, limit, expected] of [
    [png, 8, /maxImageBytes/],
    [Buffer.from("<html>error</html>"), 1024, /unsupported image/],
  ] as const) {
    const url = await server(t, (_req, res) =>
      res.end(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] })),
    )
    const f = await fixture(t, url)
    await assert.rejects(
      generate(f.ctx, { ...f.options, maxImageBytes: limit }, { prompt: "Otter" }, f.context),
      expected,
    )
    assert.deepEqual(await readdir(f.directory), [])
  }
})

test("concurrent calls save distinct files without overwriting", async (t) => {
  const url = await server(t, (_req, res) => res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })))
  const f = await fixture(t, url)
  const results = await Promise.all([1, 2].map(() => generate(f.ctx, f.options, { prompt: "Otter" }, f.context)))
  assert.notDeepEqual(results[0]?.metadata?.files, results[1]?.metadata?.files)
  assert.equal((await readdir(join(f.directory, "generated-images"))).length, 2)
})

test("explicit provider overrides and apiKeyEnv take precedence", async (t) => {
  const f = await fixture(t, "https://original.example/v1")
  const previous = process.env.IMAGE_PLUGIN_TEST_KEY
  process.env.IMAGE_PLUGIN_TEST_KEY = "override-key"
  t.after(() => {
    if (previous === undefined) delete process.env.IMAGE_PLUGIN_TEST_KEY
    else process.env.IMAGE_PLUGIN_TEST_KEY = previous
  })
  const options = optionsSchema.parse({
    providers: {
      gateway: {
        baseURL: "https://override.example/v1",
        apiKeyEnv: "IMAGE_PLUGIN_TEST_KEY",
        headers: { "x-tenant": "demo" },
      },
    },
  })
  const provider = await resolveProvider(f.ctx, options, "gateway")
  assert.equal(provider.endpoint, "https://override.example/v1/images/generations")
  assert.equal(provider.headers.get("authorization"), "Bearer override-key")
  assert.equal(provider.headers.get("x-tenant"), "demo")
})

test("invalid tool input makes no network request", async (t) => {
  let calls = 0
  const url = await server(t, (_req, res) => {
    calls++
    res.end()
  })
  const f = await fixture(t, url)
  for (const input of [{ prompt: " " }, { prompt: "Otter", n: 5 }, { prompt: "Otter", model: "missing-provider" }]) {
    await assert.rejects(generate(f.ctx, f.options, input, f.context))
  }
  assert.equal(calls, 0)
})
