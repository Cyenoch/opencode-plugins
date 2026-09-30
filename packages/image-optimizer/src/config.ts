export type Format = "webp" | "jpeg" | "png"
export type Model = { providerID: string; id: string }

export interface Policy {
  formats: Format[]
  targetBytes: number
  quality: number
  minQuality: number
  allowResize: boolean
  minDimension: number
  maxBytes?: number
  maxBase64Bytes?: number
  maxDimension?: number
}

interface Rule extends Partial<Policy> {
  provider: string
  model?: string
}

export interface Options extends Omit<Policy, "formats"> {
  formats?: Format[]
  rules: Rule[]
  cacheBytes: number
  cacheDirectory?: string
  debug: boolean
}

const fields = [
  "formats",
  "targetBytes",
  "quality",
  "minQuality",
  "allowResize",
  "minDimension",
  "maxBytes",
  "maxBase64Bytes",
  "maxDimension",
] as const
const optionFields = [...fields, "rules", "cacheBytes", "cacheDirectory", "debug"]

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function validate(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown image optimizer option: ${key}`)
    if (item === undefined) continue
    if (key === "formats") {
      if (!Array.isArray(item) || !item.length || item.some((x) => !["webp", "jpeg", "png"].includes(x))) {
        throw new Error("formats must be a nonempty array of webp, jpeg, png")
      }
    } else if (["allowResize", "debug"].includes(key)) {
      if (typeof item !== "boolean") throw new Error(`${key} must be boolean`)
    } else if (["provider", "model", "cacheDirectory"].includes(key)) {
      if (typeof item !== "string" || !item.length) throw new Error(`${key} must be a nonempty string`)
    } else if (key !== "rules") {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)
        throw new Error(`${key} must be a positive integer`)
      if (["quality", "minQuality"].includes(key) && item > 100) throw new Error(`${key} must be <= 100`)
    }
  }
}

export function parseOptions(input: unknown): Options {
  const raw = object(input, "options")
  validate(raw, optionFields)
  const options: Options = {
    targetBytes: 1024 * 1024,
    quality: 92,
    minQuality: 85,
    allowResize: false,
    minDimension: 1024,
    cacheBytes: 256 * 1024 * 1024,
    debug: false,
    ...raw,
    rules: [],
  }
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) throw new Error("rules must be an array")
    options.rules = raw.rules.map((item) => {
      const rule = object(item, "rule")
      validate(rule, [...fields, "provider", "model"])
      if (typeof rule.provider !== "string") throw new Error("rule.provider is required")
      return rule as unknown as Rule
    })
  }
  checkPolicy(options)
  for (const rule of options.rules) checkPolicy({ ...options, ...rule })
  return options
}

function checkPolicy(policy: Pick<Policy, "quality" | "minQuality">) {
  if (policy.minQuality > policy.quality) throw new Error("minQuality must be <= quality")
}

function matches(pattern: string, text: string) {
  const regex = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${regex}$`).test(text)
}

export function policyFor(options: Options, model?: Model): Policy {
  const { rules, cacheBytes, cacheDirectory, debug, ...defaults } = options
  // These are provider IDs, not guesses based on the model name. Overrides win.
  const official = model && ["openai", "anthropic"].includes(model.providerID)
  let policy: Policy = {
    ...defaults,
    formats: options.formats ?? (official ? ["webp", "jpeg", "png"] : ["jpeg", "png"]),
  }
  for (const { provider, model: pattern = "*", ...overrides } of rules) {
    if (model && matches(provider, model.providerID) && matches(pattern, model.id)) policy = { ...policy, ...overrides }
  }
  checkPolicy(policy)
  return policy
}
