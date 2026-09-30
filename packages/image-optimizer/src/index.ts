import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { hash, ImageCache } from "./cache.js"
import { parseOptions, policyFor } from "./config.js"
import { optimizeRequest, optimizeResult } from "./hooks.js"
import { Optimizer } from "./optimizer.js"

export default Plugin.define({
  id: "cyenoch.image-optimizer",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const root =
      options.cacheDirectory ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-image-optimizer")
    if (!isAbsolute(root)) throw new Error("image-optimizer.cacheDirectory must be absolute")
    const cache = new ImageCache(join(root, hash(ctx.location.directory)), options.cacheBytes)
    await cache.init()
    const optimizer = new Optimizer(cache, options.debug)

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "read" || event.status !== "completed" || !Array.isArray(event.result.content)) return
      if (!event.result.content.some((item) => item.type === "file" && item.mime.startsWith("image/"))) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      event.result = await optimizeResult(event.result, optimizer, policyFor(options, session.model))
    })

    for (const hook of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(hook, (event) => optimizeRequest(event, optimizer, options))
    }
  },
})
