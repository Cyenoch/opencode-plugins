import { Plugin } from "@opencode/plugin"
import { inputSchema, optionsSchema } from "./config.js"
import { generate } from "./generate.js"

export default Plugin.define({
  id: "cyenoch.image-generation",
  async setup(ctx) {
    const options = optionsSchema.parse(ctx.options)
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "generate_image",
        description:
          "Generate images from a text prompt using an OpenAI-compatible Images API. Saves images to the session's project and returns file attachments and absolute paths. Use for illustrations, UI assets, logos, and other requested images. The optional model is provider/model; extra slashes remain part of the model ID.",
        input: inputSchema,
        options: { codemode: true },
        execute: (input, context) => generate(ctx, options, input, context),
      })
    })
  },
})
