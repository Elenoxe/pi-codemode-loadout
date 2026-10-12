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
function specificity(value: string | ToolSelector): number {
  const selector = typeof value === "string" ? { name: value } : value
  return (
    (selector.name !== undefined ? 4 : 0) +
    (selector.namespace !== undefined ? 2 : 0) +
    (selector.source !== undefined ? 1 : 0)
  )
}
export function resolveRule(tool: Identity, rules: readonly ToolRule[]): ToolRule | undefined {
  let winner: ToolRule | undefined
  let best = -1
  for (const rule of rules) {
    for (const selector of rule.match) {
      if (matches(tool, selector) && specificity(selector) > best) {
        best = specificity(selector)
        winner = rule
      }
    }
  }
  return winner
}
