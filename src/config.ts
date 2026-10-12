import { readFileSync } from "node:fs"
import { join } from "node:path"

export type Level = "auto" | "full" | "hint" | "name" | "omit"
export interface ToolSelector {
  name?: string
  namespace?: string | null
  source?: string
}
export interface ToolRule {
  match: (string | ToolSelector)[]
  level?: Level
  priority?: number
  forceExpose?: boolean
}
export interface CatalogConfig {
  enabled: boolean
  budget: number | "inherit"
  exposeAllActiveTools: boolean
  rules: ToolRule[]
}
export const DEFAULT_CONFIG: CatalogConfig = {
  enabled: true,
  budget: "inherit",
  exposeAllActiveTools: false,
  rules: [],
}
export const CONFIG_FILENAME = "codemode-tool-catalog.json"

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected an object`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key}: unknown field`)
  }
}
function exact(value: unknown, path: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("*"))
    throw new Error(`${path}: expected a nonempty exact string (wildcards are not supported)`)
}
export function validateConfig(value: unknown, path = "config"): Partial<CatalogConfig> {
  const config = object(value, path)
  keys(config, ["enabled", "budget", "exposeAllActiveTools", "rules"], path)
  for (const key of ["enabled", "exposeAllActiveTools"]) {
    if (key in config && typeof config[key] !== "boolean")
      throw new Error(`${path}.${key}: expected boolean`)
  }
  if (
    "budget" in config &&
    config.budget !== "inherit" &&
    (typeof config.budget !== "number" || !Number.isFinite(config.budget) || config.budget < 0)
  )
    throw new Error(`${path}.budget: expected a finite nonnegative number or "inherit"`)
  if ("rules" in config) {
    if (!Array.isArray(config.rules)) throw new Error(`${path}.rules: expected an array`)
    for (const [index, value] of config.rules.entries()) {
      const location = `${path}.rules[${index}]`
      const rule = object(value, location)
      keys(rule, ["match", "level", "priority", "forceExpose"], location)
      if (!Array.isArray(rule.match) || rule.match.length === 0)
        throw new Error(`${location}.match: expected a nonempty array`)
      for (const [index, value] of rule.match.entries()) {
        const target = `${location}.match[${index}]`
        if (typeof value === "string") exact(value, target)
        else {
          const selector = object(value, target)
          keys(selector, ["name", "namespace", "source"], target)
          if (Object.keys(selector).length === 0) throw new Error(`${target}: empty selector`)
          for (const key of Object.keys(selector)) {
            if (key !== "namespace" || selector[key] !== null)
              exact(selector[key], `${target}.${key}`)
          }
        }
      }
      if ("level" in rule && !["auto", "full", "hint", "name", "omit"].includes(String(rule.level)))
        throw new Error(`${location}.level: invalid level`)
      if (
        "priority" in rule &&
        (typeof rule.priority !== "number" || !Number.isFinite(rule.priority))
      )
        throw new Error(`${location}.priority: expected a finite number`)
      if ("forceExpose" in rule && typeof rule.forceExpose !== "boolean")
        throw new Error(`${location}.forceExpose: expected boolean`)
    }
  }
  return config as Partial<CatalogConfig>
}

function readConfig(path: string): Partial<CatalogConfig> {
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
  return validateConfig(value, path)
}
export function loadConfig(agentDir: string, cwd: string, projectTrusted: boolean): CatalogConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfig(join(agentDir, CONFIG_FILENAME)),
    ...(projectTrusted ? readConfig(join(cwd, ".pi", CONFIG_FILENAME)) : {}),
  }
}
export function isNativeConfig(config: CatalogConfig): boolean {
  return (
    !config.enabled ||
    (config.budget === "inherit" && !config.exposeAllActiveTools && config.rules.length === 0)
  )
}
