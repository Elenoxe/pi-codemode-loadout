import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode"
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations"
import type { ToolInfo, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { CatalogConfig, ToolRule } from "./config"
import { isNativeConfig } from "./config"
import { matches, resolveRule } from "./rules"

export interface CatalogToolInfo extends ToolInfo {
  outputSchema?: ToolDefinition["outputSchema"]
}
export interface CatalogOptions {
  tools: readonly CatalogToolInfo[]
  active: ReadonlySet<string>
  mode: "on" | "only"
  inlineBudget: number
}
export function toolHeading(name: string): string {
  const id = toCodemodeIdentifier(name)
  return id === name ? `### \`${id}\`` : `### \`${id}\` (\`${name}\`)`
}
/** Parse only native catalog boundaries outside fenced description/schema blocks. */
export function readNativeCatalog(description: string, tools: readonly ToolInfo[]) {
  const marker = "\n\nNested tools:"
  const start = description.indexOf(marker)
  if (start < 0) return { prefix: description, sections: new Map<string, string>() }
  const prefix = description.slice(0, start)
  const headings = new Map(tools.map((tool) => [toolHeading(tool.name), tool]))
  const namespaces = new Set(tools.flatMap((tool) => (tool.namespace ? [tool.namespace.name] : [])))
  const sections = new Map<string, string>()
  let name: string | undefined
  let lines: string[] = []
  let fence: string | undefined
  let protectedUntil = -1
  const finish = () => {
    if (name) sections.set(name, lines.join("\n").trimEnd())
  }
  const sourceLines = description.slice(start + marker.length).split("\n")
  for (const [index, line] of sourceLines.entries()) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1]!
      else if (delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length)
        fence = undefined
    }
    const next = !fence && index > protectedUntil ? headings.get(line) : undefined
    const ns =
      !fence &&
      index > protectedUntil &&
      [...namespaces].some(
        (value) =>
          line === `## ${value}` ||
          line === `## ${value} (tools not listed)` ||
          line === `## ${value} (some tools not listed)`,
      )
    if (next || ns) {
      finish()
      name = next?.name
      lines = next ? [line] : []
      if (next) {
        const body = fullDescription(next).trim()
        if (
          sourceLines
            .slice(index + 1)
            .join("\n")
            .startsWith(body + "\n\ncodemode tool declaration:")
        )
          protectedUntil = index + body.split("\n").length
      }
    } else if (name) lines.push(line)
  }
  finish()
  return { prefix, sections }
}
export function candidateTools(options: CatalogOptions, config: CatalogConfig): CatalogToolInfo[] {
  return options.tools.filter((tool) => {
    if (tool.name === "codemode" || tool.exposure === "hidden" || tool.exposure === "model-only")
      return false
    const rule = resolveRule(tool, config.rules)
    if (rule?.level === "omit") return false
    if (tool.exposure === "direct") return options.mode === "only" && options.active.has(tool.name)
    if (tool.exposure !== "deferred") return true
    // Deferred discovery remains native unless a rule explicitly selects MCP presentation.
    if (!tool.name.startsWith("mcp__") || !rule || (rule.level === undefined && !rule.forceExpose))
      return false
    return rule.match.some((value) => {
      const selector = typeof value === "string" ? { name: value } : value
      return (
        matches(tool, selector) &&
        (selector.name?.startsWith("mcp__") ||
          selector.namespace?.startsWith("mcp__") ||
          (selector.source !== undefined && selector.source !== "builtin"))
      )
    })
  })
}
function assemble(
  prefix: string,
  tools: readonly ToolInfo[],
  sections: ReadonlyMap<string, string>,
): string {
  if (tools.length === 0) return prefix
  const groups = new Map<string, ToolInfo[]>()
  for (const tool of tools) {
    const key = tool.namespace?.name ?? ""
    const group = groups.get(key) ?? []
    group.push(tool)
    groups.set(key, group)
  }
  const output = ["Nested tools:"]
  for (const [name, group] of [...groups].sort(([a], [b]) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  )) {
    const visible = group.filter((tool) => sections.has(tool.name))
    if (name) {
      const listing =
        visible.length === group.length
          ? ""
          : visible.length === 0
            ? " (tools not listed)"
            : " (some tools not listed)"
      const description = group[0]?.namespace?.description?.trim()
      output.push(`## ${name}${listing}${description ? "\n" + description : ""}`)
    }
    for (const tool of visible) output.push(sections.get(tool.name)!)
  }
  return prefix + "\n\n" + output.join("\n\n")
}
function fullDescription(tool: ToolInfo): string {
  const bullets = (tool.promptGuidelines ?? []).flatMap((value) =>
    value.trim() ? ["- " + value.trim()] : [],
  )
  return bullets.length ? tool.description.trim() + "\n\n" + bullets.join("\n") : tool.description
}
type DisplayLevel = "full" | "hint" | "name"
export function renderEntry(
  tool: CatalogToolInfo,
  level: DisplayLevel,
  nativeFull?: string,
): string {
  const heading = toolHeading(tool.name)
  if (level === "name") return heading
  if (level === "hint") {
    const paragraph = tool.description.trim().split(/\n\s*\n/)[0] ?? ""
    const hint = paragraph.replace(/\s+/g, " ").slice(0, 160)
    return hint ? heading + "\n" + hint : heading
  }
  if (nativeFull !== undefined) return nativeFull
  const description = fullDescription(tool)
  return (
    heading +
    "\n" +
    renderToolSample({
      name: tool.name,
      description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: (tool.outputSchema ?? { type: "string" }) as CodemodeJsonSchema,
    }).trim()
  )
}
interface Entry {
  tool: CatalogToolInfo
  rule: ToolRule | undefined
  texts: Record<DisplayLevel, string>
  preferred: DisplayLevel
  minimum?: DisplayLevel
}
export function sectionCost(text: string): number {
  return Math.ceil(text.length / 4)
}
function allocate(entries: Entry[], budget: number): Map<string, string> {
  const shown = new Map<string, string>()
  let remaining = budget
  for (const entry of entries) {
    if (!entry.minimum) continue
    shown.set(entry.tool.name, entry.texts[entry.minimum])
    remaining -= sectionCost(entry.texts[entry.minimum])
  }
  if (remaining < 0) return shown
  const priorities = [...new Set(entries.map((entry) => entry.rule?.priority ?? 0))].sort(
    (a, b) => b - a,
  )
  for (const priority of priorities) {
    const groups = new Map<string, Entry[]>()
    for (const entry of entries.filter((entry) => (entry.rule?.priority ?? 0) === priority)) {
      const key = entry.tool.namespace?.name ?? ""
      const group = groups.get(key) ?? []
      group.push(entry)
      groups.set(key, group)
    }
    const queues = [...groups]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([, group]) =>
        group.sort((a, b) => sectionCost(a.texts[a.preferred]) - sectionCost(b.texts[b.preferred])),
      )
    while (queues.some((queue) => queue.length > 0)) {
      for (const queue of queues) {
        const entry = queue.shift()
        if (!entry) continue
        const levels: DisplayLevel[] =
          entry.rule?.level === "auto" ? ["full", "hint", "name"] : [entry.preferred]
        const reserved = entry.minimum ? sectionCost(entry.texts[entry.minimum]) : 0
        const level = levels.find(
          (level) => sectionCost(entry.texts[level]) - reserved <= remaining,
        )
        if (level) {
          shown.set(entry.tool.name, entry.texts[level])
          remaining -= sectionCost(entry.texts[level]) - reserved
        }
      }
    }
  }
  return shown
}
export function createCatalog(
  description: string,
  config: CatalogConfig,
  options: CatalogOptions,
): string {
  if (isNativeConfig(config)) return description
  const native = readNativeCatalog(description, options.tools)
  const tools = candidateTools(options, config)
  const entries = tools.map((tool): Entry => {
    const rule = resolveRule(tool, config.rules)
    return {
      tool,
      rule,
      minimum: rule?.forceExpose
        ? rule.level === "full" || rule.level === "hint" || rule.level === "name"
          ? rule.level
          : "name"
        : config.exposeAllActiveTools && options.active.has(tool.name)
          ? "name"
          : undefined,
      preferred: rule?.level === "hint" || rule?.level === "name" ? rule.level : "full",
      texts: {
        full: renderEntry(tool, "full", native.sections.get(tool.name)),
        hint: renderEntry(tool, "hint"),
        name: renderEntry(tool, "name"),
      },
    }
  })
  const budget = config.budget === "inherit" ? options.inlineBudget : config.budget
  const shown = allocate(entries, budget)
  return assemble(native.prefix, tools, shown)
}
