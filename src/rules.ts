import type { ToolInfo } from "@earendil-works/pi-coding-agent"
import type { ToolRule, ToolSelector } from "./config"

type Identity = Pick<ToolInfo, "name" | "namespace" | "sourceInfo">
export function matches(tool: Identity, value: string | ToolSelector): boolean {
  const selector = typeof value === "string" ? { name: value } : value
  return (
    (selector.name === undefined || selector.name === tool.name) &&
    (selector.namespace === undefined || selector.namespace === (tool.namespace?.name ?? null)) &&
    (selector.source === undefined || selector.source === tool.sourceInfo.source)
  )
}
export function resolveRule(tool: Identity, rules: readonly ToolRule[]): ToolRule | undefined {
  return rules.find((rule) => rule.match.some((selector) => matches(tool, selector)))
}
