import type { SessionRequest } from "@opencode/plugin/promise/session"
import type { Result } from "@opencode/plugin/promise/tool"
import { type Options, type Policy, policyFor } from "./config.js"
import { decode, type Optimizer } from "./optimizer.js"

export async function optimizeResult(result: Result, optimizer: Optimizer, policy: Policy): Promise<Result> {
  if (!Array.isArray(result.content)) return result
  let changed = false
  const content = []
  for (const item of result.content) {
    const next = item.type === "file" ? await optimizer.file(item, policy) : item
    changed ||= next !== item
    content.push(next)
  }
  if (!changed) return result
  // Native read includes a second copy of the image in structured output.
  // Keep it consistent rather than persisting the original oversized base64.
  let output = result.output
  if (
    output &&
    typeof output === "object" &&
    "type" in output &&
    output.type === "file" &&
    "encoding" in output &&
    output.encoding === "base64"
  ) {
    const image = content.find((item) => item.type === "file" && decode(item))
    if (image?.type === "file")
      output = { ...output, mime: image.mime, content: decode(image)!.data.toString("base64") }
  }
  return { ...result, content, output }
}

export async function optimizeRequest(event: SessionRequest, optimizer: Optimizer, options: Options) {
  const policy = policyFor(options, event.model)
  // Work on the outgoing draft only. Persisted history stays stable when the
  // user changes provider, and other tools/user attachments are left alone.
  for (let i = 0; i < event.messages.length; i++) {
    const message = event.messages[i]!
    let changed = false
    const content = []
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.name !== "read" || part.result.type !== "content") {
        content.push(part)
        continue
      }
      const result = await optimizeResult({ content: part.result.value }, optimizer, policy)
      if (result.content !== part.result.value && Array.isArray(result.content)) {
        changed = true
        content.push({ ...part, result: { ...part.result, value: result.content } })
      } else content.push(part)
    }
    if (changed) event.messages[i] = { ...message, content }
  }
}
