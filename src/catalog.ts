import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode"
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations"
import type { ToolInfo, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { CatalogConfig, ToolRule, Level as DisplayLevel, DiagnosticReporter } from "./config"
import { isNativeConfig, LEVELS, reportToConsole } from "./config"
import { matches, resolveRule } from "./rules"

export interface CatalogToolInfo extends ToolInfo {
  outputSchema?: ToolDefinition["outputSchema"]
  promptSnippet?: ToolDefinition["promptSnippet"]
}
export interface CatalogOptions {
  tools: readonly CatalogToolInfo[]
  active: ReadonlySet<string>
  mode: "on" | "only"
  inlineBudget: number
  reportDiagnostic?: DiagnosticReporter
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
  const namespaces = tools.flatMap((tool) => (tool.namespace ? [tool.namespace] : []))
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
      namespaces.find(
        (value) =>
          line === `## ${value.name}` ||
          line === `## ${value.name} (tools not listed)` ||
          line === `## ${value.name} (some tools not listed)`,
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
      } else if (ns) {
        const body = ns.description?.trim()
        if (
          body &&
          sourceLines
            .slice(index + 1)
            .join("\n")
            .startsWith(body)
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
    if (rule?.maxLevel === "omit") return false
    if (tool.exposure === "direct") return options.mode === "only" && options.active.has(tool.name)
    if (tool.exposure !== "deferred") return true
    // Deferred discovery remains native unless a rule explicitly selects MCP presentation.
    if (!tool.name.startsWith("mcp__") || rule?.minLevel === undefined) return false
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
const NAME_LIST_HEADER = "Other available tools (inspect with `describeTool(name)`):\n"
function assemble(
  prefix: string,
  tools: readonly ToolInfo[],
  sections: ReadonlyMap<string, AllocatedTool>,
): string {
  if (tools.length === 0) return prefix
  const groups = new Map<string, ToolInfo[]>()
  for (const tool of tools) {
    const key = tool.namespace?.name ?? ""
    const group = groups.get(key) ?? []
    group.push(tool)
    groups.set(key, group)
  }
  const output: string[] = []
  const names: string[] = []
  for (const [name, group] of [...groups].sort(([a], [b]) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  )) {
    const visible = group.filter((tool) => sections.has(tool.name))
    const declarations = visible.filter((tool) => sections.get(tool.name)!.level !== "name")
    names.push(
      ...visible
        .filter((tool) => sections.get(tool.name)!.level === "name")
        .map((tool) => tool.name),
    )
    if (visible.length > 0 && declarations.length === 0) continue
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
    for (const tool of declarations) output.push(sections.get(tool.name)!.text)
  }
  if (output.length > 0) output.unshift("Nested tools:")
  if (names.length > 0)
    output.push(NAME_LIST_HEADER + names.map((name) => `\`${name}\``).join(", "))
  return output.length > 0 ? prefix + "\n\n" + output.join("\n\n") : prefix
}
function fullDescription(tool: ToolInfo): string {
  const bullets = (tool.promptGuidelines ?? []).flatMap((value) =>
    value.trim() ? ["- " + value.trim()] : [],
  )
  return bullets.length ? tool.description.trim() + "\n\n" + bullets.join("\n") : tool.description
}
interface AllocatedTool {
  level: DisplayLevel
  text: string
}
export function renderEntry(
  tool: CatalogToolInfo,
  level: DisplayLevel,
  nativeFull?: string,
  hintOverride?: string,
): string {
  const heading = toolHeading(tool.name)
  if (level === "name") return heading
  if (level === "hint") {
    const hint = (hintOverride ?? tool.promptSnippet)?.trim()
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
      outputSchema: tool.outputSchema as CodemodeJsonSchema | undefined,
    }).trim()
  )
}
interface Entry {
  tool: CatalogToolInfo
  rule: ToolRule | undefined
  texts: Record<DisplayLevel, string>
  maximum: DisplayLevel
  minimum?: DisplayLevel
}
export function sectionCost(text: string): number {
  return Math.ceil(text.length / 4)
}
function allocate(entries: Entry[], budget: number): Map<string, AllocatedTool> {
  const shown = new Map<string, AllocatedTool>()
  let nameCount = 0
  let nameChars = 0
  const nameCost = (count: number, chars: number) =>
    count === 0 ? 0 : Math.ceil((NAME_LIST_HEADER.length + chars + 2 * (count - 1)) / 4)
  const displayLevel = (entry: Entry, level: DisplayLevel): DisplayLevel =>
    level === "hint" && entry.texts.hint === entry.texts.name ? "name" : level
  const changeCost = (entry: Entry, level: DisplayLevel) => {
    const current = shown.get(entry.tool.name)
    const wasName = current?.level === "name"
    const isName = displayLevel(entry, level) === "name"
    const change = Number(isName) - Number(wasName)
    return (
      (isName ? 0 : sectionCost(entry.texts[level])) -
      (current && !wasName ? sectionCost(current.text) : 0) +
      nameCost(nameCount + change, nameChars + change * (entry.tool.name.length + 2)) -
      nameCost(nameCount, nameChars)
    )
  }
  const show = (entry: Entry, level: DisplayLevel) => {
    remaining -= changeCost(entry, level)
    const actualLevel = displayLevel(entry, level)
    const change =
      Number(actualLevel === "name") - Number(shown.get(entry.tool.name)?.level === "name")
    nameCount += change
    nameChars += change * (entry.tool.name.length + 2)
    shown.set(entry.tool.name, { level: actualLevel, text: entry.texts[level] })
  }
  let remaining = budget
  for (const entry of entries) {
    if (!entry.minimum) continue
    show(entry, entry.minimum)
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
    const namespaces = [...groups]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([, group]) => group)
    for (const target of LEVELS) {
      const queues = namespaces.map((group) =>
        group.filter((entry) => {
          const current = shown.get(entry.tool.name)?.level
          return (
            (current === undefined || LEVELS.indexOf(current) < LEVELS.indexOf(target)) &&
            LEVELS.indexOf(target) <= LEVELS.indexOf(entry.maximum) &&
            (target !== "hint" || entry.texts.hint !== entry.texts.name)
          )
        }),
      )
      while (queues.some((queue) => queue.length > 0)) {
        for (const queue of queues) {
          queue.sort((a, b) => changeCost(a, target) - changeCost(b, target))
          const entry = queue.shift()
          if (!entry) continue
          if (changeCost(entry, target) <= remaining) show(entry, target)
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
  const reportDiagnostic = options.reportDiagnostic ?? reportToConsole
  const entries = tools.map((tool): Entry => {
    const rule = resolveRule(tool, config.rules)
    const hint = renderEntry(tool, "hint", undefined, rule?.hint)
    const name = renderEntry(tool, "name")
    const missingMinimumHint = rule?.minLevel === "hint" && hint === name
    if (missingMinimumHint && rule?.hint === undefined) {
      reportDiagnostic(
        `Tool ${tool.name}: minLevel "hint" has no non-empty hint or promptSnippet; using minimum Name`,
        "error",
      )
    }
    let full: string | undefined
    return {
      tool,
      rule,
      minimum: missingMinimumHint
        ? "name"
        : (rule?.minLevel ??
          (config.exposeAllActiveTools && options.active.has(tool.name) ? "name" : undefined)),
      maximum: rule?.maxLevel === "hint" || rule?.maxLevel === "name" ? rule.maxLevel : "full",
      texts: {
        get full() {
          return (full ??= renderEntry(tool, "full", native.sections.get(tool.name)))
        },
        hint,
        name,
      },
    }
  })
  const budget = config.budget === "inherit" ? options.inlineBudget : config.budget
  const shown = allocate(entries, budget)
  return assemble(native.prefix, tools, shown)
}
