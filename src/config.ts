import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

const ExactStringSchema = Type.String({ pattern: "^(?!\\s*$)[^*]+$" })
export const LEVELS = ["name", "hint", "full"] as const
const LevelSchema = Type.Union([Type.Literal("name"), Type.Literal("hint"), Type.Literal("full")])
const MaxLevelSchema = Type.Union([LevelSchema, Type.Literal("omit")])
const ToolSelectorSchema = Type.Object(
  {
    name: Type.Optional(ExactStringSchema),
    namespace: Type.Optional(Type.Union([ExactStringSchema, Type.Null()])),
    source: Type.Optional(ExactStringSchema),
  },
  { additionalProperties: false, minProperties: 1 },
)
const ToolRuleSchema = Type.Object(
  {
    match: Type.Array(Type.Union([ExactStringSchema, ToolSelectorSchema]), { minItems: 1 }),
    minLevel: Type.Optional(LevelSchema),
    maxLevel: Type.Optional(MaxLevelSchema),
    hint: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
)
const CatalogConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    budget: Type.Union([Type.Number({ minimum: 0 }), Type.Literal("inherit")]),
    exposeAllActiveTools: Type.Boolean(),
    rules: Type.Array(ToolRuleSchema),
  },
  { additionalProperties: false },
)
const PartialConfigSchema = Type.Partial(CatalogConfigSchema, { additionalProperties: false })
export type Level = Static<typeof LevelSchema>
export type ToolSelector = Static<typeof ToolSelectorSchema>
export type ToolRule = Static<typeof ToolRuleSchema>
export type CatalogConfig = Static<typeof CatalogConfigSchema>
export const DEFAULT_CONFIG: CatalogConfig = {
  enabled: true,
  budget: "inherit",
  exposeAllActiveTools: false,
  rules: [],
}
export const CONFIG_FILENAME = "codemode-tool-catalog.json"

export type DiagnosticReporter = (message: string, severity: "error" | "warning") => void
export const reportToConsole: DiagnosticReporter = (message, severity) => {
  if (severity === "warning") console.warn(message)
  else console.error(message)
}

export function validateConfig(
  value: unknown,
  path = "config",
  reportDiagnostic: DiagnosticReporter = reportToConsole,
): Partial<CatalogConfig> {
  if (!Value.Check(PartialConfigSchema, value)) {
    const error = Value.Errors(PartialConfigSchema, value)[0]!
    throw new Error(`${path}${error.instancePath}: ${error.message}`)
  }
  const config = { ...(value as Partial<CatalogConfig>) }
  if (config.rules) config.rules = [...config.rules]
  for (const [index, rule] of (config.rules ?? []).entries()) {
    if (
      rule.minLevel !== undefined &&
      (rule.maxLevel === "omit" ||
        LEVELS.indexOf(rule.minLevel) > LEVELS.indexOf(rule.maxLevel ?? "full"))
    ) {
      reportDiagnostic(
        `${path}/rules/${index}/minLevel: exceeds maxLevel; ignoring both level bounds`,
        "error",
      )
      const normalized = { ...rule }
      delete normalized.minLevel
      delete normalized.maxLevel
      config.rules![index] = normalized
    }
    if (rule.hint === undefined) continue
    const selector = rule.match[0]
    const named =
      typeof selector === "string" || (typeof selector === "object" && selector.name !== undefined)
    if (rule.match.length !== 1 || !named) {
      reportDiagnostic(
        `${path}/rules/${index}/hint: applies to multiple tools or a non-named selector`,
        "warning",
      )
    }
  }
  return config
}

function readConfig(path: string, reportDiagnostic: DiagnosticReporter): Partial<CatalogConfig> {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`${path}: invalid JSON`, { cause: error })
  }
  return validateConfig(value, path, reportDiagnostic)
}
export function loadConfig(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  reportDiagnostic: DiagnosticReporter = reportToConsole,
): CatalogConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfig(join(agentDir, CONFIG_FILENAME), reportDiagnostic),
    ...(projectTrusted ? readConfig(join(cwd, ".pi", CONFIG_FILENAME), reportDiagnostic) : {}),
  }
}
export function isNativeConfig(config: CatalogConfig): boolean {
  return (
    !config.enabled ||
    (config.budget === "inherit" && !config.exposeAllActiveTools && config.rules.length === 0)
  )
}
