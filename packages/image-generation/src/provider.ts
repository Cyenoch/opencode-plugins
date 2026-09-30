import type { Plugin } from "@opencode/plugin"
import type { Options } from "./config.js"

export interface ImageProvider {
  endpoint: string
  headers: Headers
  body: Record<string, unknown>
}

export type ProviderContext = Pick<Plugin.Context, "provider" | "integration">

export async function resolveProvider(
  ctx: ProviderContext,
  options: Options,
  providerID: string,
): Promise<ImageProvider> {
  const override = options.providers[providerID]
  const { data } = await ctx.provider.list()
  const provider = data.find((item) => item.id === providerID)
  if (provider?.activation === "disabled") throw new Error(`Provider ${providerID} is disabled`)

  const settings = provider?.settings
  const baseURL =
    override?.baseURL ??
    (typeof settings?.baseURL === "string" ? settings.baseURL : undefined) ??
    (providerID === "openai" ? "https://api.openai.com/v1" : undefined)
  if (!baseURL)
    throw new Error(`Set options.providers.${providerID}.baseURL to an OpenAI-compatible Images API base URL`)
  const endpoint = new URL(`${baseURL.replace(/\/+$/, "")}/images/generations`)
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Image provider baseURL must be an HTTP(S) URL without credentials, query, or fragment")
  }

  const headers = new Headers(provider?.headers)
  for (const [name, value] of Object.entries(override?.headers ?? {})) headers.set(name, value)
  let key: string | undefined
  if (override?.apiKeyEnv) {
    key = process.env[override.apiKeyEnv]
    if (!key) throw new Error(`Missing environment variable ${override.apiKeyEnv} in the OpenCode server process`)
  } else if (!headers.has("authorization")) {
    if (typeof settings?.apiKey === "string") key = settings.apiKey
    if (!key && providerID === "openai") key = process.env.OPENAI_API_KEY
    if (!key) {
      const integrationID = override?.integrationID ?? provider?.integrationID ?? providerID
      const connection = await ctx.integration.connection.active(integrationID)
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type === "key") key = credential.key
      // Subscription OAuth tokens may target a different endpoint/protocol than Images.
      if (credential?.type === "oauth") {
        throw new Error(`Provider ${providerID} uses OAuth. Configure apiKeyEnv for an Images API key`)
      }
    }
  }
  if (key) headers.set("authorization", `Bearer ${key}`)
  headers.set("content-type", "application/json")
  return { endpoint: endpoint.href, headers, body: override?.body ?? {} }
}
