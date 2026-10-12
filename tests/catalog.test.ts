import { expect, test } from "bun:test"
import type { ToolInfo } from "@earendil-works/pi-coding-agent"
import { DEFAULT_CONFIG } from "../src/config"
import { createCatalog, readNativeCatalog, renderEntry, toolHeading } from "../src/catalog"

function tool(name: string, description = "Search file contents."): ToolInfo {
  return {
    name,
    description,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    exposure: "codemode",
    promptGuidelines: ["Keep paths scoped."],
    sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
  }
}
const native = (tools: ToolInfo[]) =>
  "Native execution instructions\n\nGlobals:\n- describeTool()\n\nNested tools:\n\n" +
  tools.map((item) => renderEntry(item, "full")).join("\n\n")
const options = (tools: ToolInfo[], inlineBudget = 10000) => ({
  tools,
  inlineBudget,
  active: new Set(tools.map((t) => t.name)),
  mode: "only" as const,
})

test("Full preserves original text and guidelines; new output types remain unknown", () => {
  const item = tool("search")
  expect(renderEntry(item, "full", "original exact bytes")).toBe("original exact bytes")
  expect(renderEntry(item, "full")).toContain("Keep paths scoped.")
  expect(renderEntry(item, "full")).toContain("Promise<unknown>")
  expect(renderEntry(item, "full")).toContain("path: string")
})
test("Hint is deterministic, bounded and excludes schemas and guidelines; Name is just the heading", () => {
  const item = tool("search", "  First paragraph\n continues.\n\nSecond paragraph.")
  expect(renderEntry(item, "hint")).toBe("### `search`\nFirst paragraph continues.")
  expect(renderEntry(tool("long", "x".repeat(1000)), "hint")).toHaveLength(
    toolHeading("long").length + 161,
  )
  expect(renderEntry(item, "name")).toBe("### `search`")
})
test("catalog retains native instructions, applies fixed levels and excludes Omit", () => {
  const tools = [tool("full"), tool("hint"), tool("name"), tool("omit")]
  const result = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      rules: tools.map((t) => ({
        match: [t.name],
        level: t.name as "full" | "hint" | "name" | "omit",
      })),
    },
    options(tools),
  )
  expect(result).toStartWith("Native execution instructions\n\nGlobals:\n- describeTool()")
  expect(readNativeCatalog(result, tools).sections.get("full")).toContain("declare const tools")
  expect(readNativeCatalog(result, tools).sections.get("hint")).not.toContain("declare const tools")
  expect(readNativeCatalog(result, tools).sections.get("name")).toBe(toolHeading("name"))
  expect(result).not.toContain(toolHeading("omit"))
})
test("catalog parser does not split headings inside fenced descriptions", () => {
  const tools = [tool("a"), tool("b")]
  const section = toolHeading("a") + "\n```md\n" + toolHeading("b") + "\n```\nreal content"
  const result = readNativeCatalog(
    "intro\n\nNested tools:\n\n" + section + "\n\n" + toolHeading("b") + "\nother",
    tools,
  )
  expect(result.sections.get("a")).toBe(section)
  expect(result.sections.get("b")).toBe(toolHeading("b") + "\nother")
})

test("Auto downgrades; omitted level and fixed Full never silently become Hint", () => {
  const item = tool("search", "Description " + "x".repeat(300))
  const description = native([item])
  const hintCost = Math.ceil(renderEntry(item, "hint").length / 4)
  const config = {
    ...DEFAULT_CONFIG,
    budget: hintCost,
    rules: [{ match: ["search"], level: "auto" as const }],
  }
  expect(
    readNativeCatalog(createCatalog(description, config, options([item])), [item]).sections.get(
      "search",
    ),
  ).toBe(renderEntry(item, "hint"))
  for (const level of [undefined, "full" as const]) {
    expect(
      readNativeCatalog(
        createCatalog(
          description,
          { ...config, rules: [{ match: ["search"], level }] },
          options([item]),
        ),
        [item],
      ).sections.size,
    ).toBe(0)
  }
  const nameCost = Math.ceil(renderEntry(item, "name").length / 4)
  expect(
    readNativeCatalog(
      createCatalog(description, { ...config, budget: nameCost }, options([item])),
      [item],
    ).sections.get("search"),
  ).toBe(renderEntry(item, "name"))
  expect(
    readNativeCatalog(
      createCatalog(description, { ...config, budget: nameCost - 1 }, options([item])),
      [item],
    ).sections.size,
  ).toBe(0)
})
test("priority precedes native namespace round-robin and cheapest-first within a group", () => {
  const big = tool("big", "x".repeat(500)),
    small = tool("small"),
    ns = tool("ns")
  ns.namespace = { name: "server", description: "Server tools" }
  const tools = [big, small, ns]
  const bigCost = Math.ceil(renderEntry(big, "full").length / 4)
  const result = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, budget: bigCost, rules: [{ match: ["big"], priority: 200 }] },
    options(tools),
  )
  expect([...readNativeCatalog(result, tools).sections.keys()]).toEqual(["big"])
  const smallCost = Math.ceil(renderEntry(small, "full").length / 4)
  const plain = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, budget: smallCost },
    options(tools),
  )
  expect([...readNativeCatalog(plain, tools).sections.keys()]).toEqual(["small"])
  const negative = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, budget: smallCost, rules: [{ match: ["small"], priority: -1 }] },
    options(tools),
  )
  expect([...readNativeCatalog(negative, tools).sections.keys()]).toEqual(["ns"])
  expect(plain).toContain("## server (tools not listed)\nServer tools")
})
test("shared budget charges actual entry text and is deterministic across boundaries", () => {
  const tools = [tool("a"), tool("b"), tool("c", "x".repeat(500))]
  for (let budget = 0; budget < 300; budget += 7) {
    const config = { ...DEFAULT_CONFIG, budget, rules: [{ match: ["c"], level: "auto" as const }] }
    const result = createCatalog(native(tools), config, options(tools))
    const sections = readNativeCatalog(result, tools).sections
    expect(
      [...sections.values()].reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
    ).toBeLessThanOrEqual(budget)
    expect(createCatalog(native(tools), config, options(tools))).toBe(result)
  }
  const inherited = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, rules: [{ match: ["a"], level: "full" }] },
    options(tools, 0),
  )
  expect(readNativeCatalog(inherited, tools).sections.size).toBe(0)
})

test("fixed forced formats exceed budget, Auto and unspecified forced levels reserve Name, Omit wins", () => {
  const tools = [
    tool("full"),
    tool("hint"),
    tool("name"),
    tool("auto"),
    tool("unspecified"),
    tool("omit"),
    tool("ordinary"),
  ]
  const config = {
    ...DEFAULT_CONFIG,
    budget: 0,
    rules: tools.slice(0, 6).map((t) => ({
      match: [t.name],
      forceExpose: true,
      level:
        t.name === "unspecified"
          ? undefined
          : (t.name as "full" | "hint" | "name" | "auto" | "omit"),
    })),
  }
  const result = readNativeCatalog(
    createCatalog(native(tools), config, options(tools)),
    tools,
  ).sections
  expect(result.get("full")).toBe(renderEntry(tools[0]!, "full"))
  expect(result.get("hint")).toBe(renderEntry(tools[1]!, "hint"))
  for (const name of ["name", "auto", "unspecified"])
    expect(result.get(name)).toBe(toolHeading(name))
  expect(result.has("omit")).toBe(false)
  expect(result.has("ordinary")).toBe(false)
})
test("reserved content upgrades using only the cost difference", () => {
  const item = tool("search"),
    description = native([item])
  const fullCost = Math.ceil(renderEntry(item, "full").length / 4)
  const result = createCatalog(
    description,
    {
      ...DEFAULT_CONFIG,
      budget: fullCost,
      rules: [{ match: ["search"], level: "auto", forceExpose: true }],
    },
    options([item]),
  )
  expect(readNativeCatalog(result, [item]).sections.get("search")).toBe(renderEntry(item, "full"))
})
test("global guarantee covers only eligible active tools and overrides fixed level with a Name minimum", () => {
  const tools = [
    tool("full"),
    tool("hint"),
    tool("omit"),
    tool("inactive"),
    tool("deferred"),
    tool("hidden"),
    tool("model"),
    tool("codemode"),
  ]
  tools[4]!.exposure = "deferred"
  tools[5]!.exposure = "hidden"
  tools[6]!.exposure = "model-only"
  const opts = options(tools)
  opts.active.delete("inactive")
  const config = {
    ...DEFAULT_CONFIG,
    budget: 0,
    exposeAllActiveTools: true,
    rules: [
      { match: ["full"], level: "full" as const },
      { match: ["hint"], level: "hint" as const },
      { match: ["omit"], level: "omit" as const },
    ],
  }
  const sections = readNativeCatalog(createCatalog(native(tools), config, opts), tools).sections
  expect([...sections.keys()]).toEqual(["full", "hint"])
  expect(sections.get("full")).toBe(toolHeading("full"))
  expect(sections.get("hint")).toBe(toolHeading("hint"))
})
test("forced minima reserve budget before high-priority optional tools", () => {
  const forced = tool("forced"),
    optional = tool("optional"),
    tools = [optional, forced]
  const budget = Math.ceil(renderEntry(optional, "full").length / 4)
  const sections = readNativeCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget,
        rules: [
          { match: ["forced"], forceExpose: true },
          { match: ["optional"], priority: 1000 },
        ],
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(sections.has("optional")).toBe(false)
  expect(sections.has("forced")).toBe(true)
})
