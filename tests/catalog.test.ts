import { expect, test } from "bun:test"
import type { CatalogToolInfo as ToolInfo } from "../src/catalog"
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

test("Full preserves native declarations and renders output types and input constraints", () => {
  const item = tool("search")
  expect(renderEntry(item, "full", "original exact bytes")).toBe("original exact bytes")
  expect(renderEntry(item, "full")).toContain("Keep paths scoped.")
  expect(renderEntry(item, "full")).toContain("Promise<string>")
  expect(renderEntry(item, "full")).toContain("path: string")
  item.outputSchema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
  }
  expect(renderEntry(item, "full")).toContain("Promise<{ answer: number; }>")
  item.parameters = {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    required: ["path"],
  }
  const full = renderEntry(item, "full")
  expect(full).toContain("// @integer @minimum 1 @maximum 20 @default 5")
  expect(full).toContain("// @minLength 1 @maxLength 100 @pattern ^[a-z]+$")
  expect(full).toContain("limit?: number;")
  expect(renderEntry(item, "hint")).not.toContain("@minimum")
  expect(renderEntry(item, "name")).not.toContain("@minimum")
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

test("on mode excludes Direct even when forced or globally guaranteed; only requires activation", () => {
  const tools = [tool("direct"), tool("inactive"), tool("mcp__docs__direct")]
  for (const item of tools) item.exposure = "direct"
  const opts = options(tools)
  opts.active.delete("inactive")
  const config = {
    ...DEFAULT_CONFIG,
    budget: 0,
    exposeAllActiveTools: true,
    rules: [
      {
        match: ["direct", "inactive", "mcp__docs__direct"],
        level: "full" as const,
        forceExpose: true,
      },
    ],
  }
  expect(
    readNativeCatalog(createCatalog(native(tools), config, { ...opts, mode: "on" }), tools).sections
      .size,
  ).toBe(0)
  expect([
    ...readNativeCatalog(createCatalog(native(tools), config, opts), tools).sections.keys(),
  ]).toEqual(["direct", "mcp__docs__direct"])
})
test("Deferred MCP requires explicit presentation selectors; generic source and Priority do not inline", () => {
  const mcp = tool("mcp__docs__search"),
    ordinary = tool("deferred")
  mcp.namespace = { name: "mcp__docs", description: "Documentation" }
  mcp.sourceInfo.source = "builtin"
  mcp.exposure = ordinary.exposure = "deferred"
  const tools = [mcp, ordinary]
  for (const rules of [
    [],
    [{ match: ["mcp__docs__search"], priority: 200 }],
    [{ match: [{ source: "builtin" }], level: "hint" as const }],
    [{ match: [{ namespace: null }], level: "hint" as const }],
  ]) {
    expect(
      readNativeCatalog(
        createCatalog(
          native(tools),
          { ...DEFAULT_CONFIG, budget: 1000, exposeAllActiveTools: true, rules },
          options(tools),
        ),
        tools,
      ).sections.size,
    ).toBe(0)
  }
  for (const match of [["mcp__docs__search"], [{ namespace: "mcp__docs" }]]) {
    const result = createCatalog(
      "intro",
      { ...DEFAULT_CONFIG, budget: 0, rules: [{ match, level: "auto", forceExpose: true }] },
      options(tools),
    )
    expect([...readNativeCatalog(result, tools).sections.keys()]).toEqual([mcp.name])
    expect(result).toContain("## mcp__docs\nDocumentation")
  }
  mcp.exposure = "hidden"
  expect(
    readNativeCatalog(
      createCatalog(
        "intro",
        { ...DEFAULT_CONFIG, rules: [{ match: [mcp.name], level: "full", forceExpose: true }] },
        options(tools),
      ),
      tools,
    ).sections.size,
  ).toBe(0)
})

test("native Full descriptions containing real catalog headings are preserved intact", () => {
  const a = tool(
    "a",
    "Example:\n\n### `b`\nDo not treat this example as a tool boundary.\n\n## server\nExample namespace heading.",
  )
  const b = tool("b")
  b.namespace = { name: "server" }
  const tools = [a, b]
  const parsed = readNativeCatalog(native(tools), tools)
  expect(parsed.sections.get("a")).toBe(renderEntry(a, "full"))
  const result = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, rules: [{ match: ["b"], level: "omit" }] },
    options(tools),
  )
  expect(readNativeCatalog(result, tools).sections.get("a")).toBe(renderEntry(a, "full"))
})

test("unspecified forced level never selects Hint and source selectors can explicitly select MCP", () => {
  const item = tool("search", "x".repeat(500))
  const config = {
    ...DEFAULT_CONFIG,
    budget: Math.ceil(renderEntry(item, "hint").length / 4),
    rules: [{ match: [item.name], forceExpose: true }],
  }
  expect(
    readNativeCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
      item.name,
    ),
  ).toBe(toolHeading(item.name))
  const mcp = tool("mcp__docs__search")
  mcp.exposure = "deferred"
  mcp.sourceInfo.source = "npm:docs-adapter"
  const result = createCatalog(
    "intro",
    { ...DEFAULT_CONFIG, rules: [{ match: [{ source: "npm:docs-adapter" }], level: "hint" }] },
    options([mcp]),
  )
  expect(readNativeCatalog(result, [mcp]).sections.get(mcp.name)).toBe(renderEntry(mcp, "hint"))
})
test("same-priority namespaces round-robin before a namespace is completed", () => {
  const a = tool("a"),
    b = tool("b"),
    c = tool("c"),
    tools = [a, b, c]
  c.namespace = { name: "server" }
  const budget =
    Math.ceil(renderEntry(a, "full").length / 4) + Math.ceil(renderEntry(c, "full").length / 4)
  const result = createCatalog(native(tools), { ...DEFAULT_CONFIG, budget }, options(tools))
  expect([...readNativeCatalog(result, tools).sections.keys()]).toEqual(["a", "c"])
})
