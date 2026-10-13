import { expect, test } from "bun:test"
import type { CatalogToolInfo as ToolInfo } from "../src/catalog"
import { DEFAULT_CONFIG } from "../src/config"
import {
  createCatalog,
  readNativeCatalog,
  renderEntry,
  sectionCost,
  toolHeading,
} from "../src/catalog"

function tool(name: string, description = "Search file contents."): ToolInfo {
  return {
    name,
    description,
    promptSnippet: "Search file contents.",
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
// Keep allocation assertions charged at the original Name heading cost.
function readCatalog(description: string, tools: ToolInfo[]) {
  const [declarations, names] = description.split(
    "\n\nOther available tools (inspect with `describeTool(name)`):\n",
  )
  const parsed = readNativeCatalog(declarations!, tools)
  if (names)
    for (const name of names.split(", ").map((value) => value.slice(1, -1)))
      parsed.sections.set(name, toolHeading(name))
  return parsed
}

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
test("Hint uses authored snippets or rule overrides, falling back to Name", () => {
  const item = tool("search", "  A long first paragraph.\n\nA second paragraph.")
  item.promptSnippet = "Find file content quickly"
  expect(renderEntry(item, "hint")).toBe("### `search`\nFind file content quickly")
  expect(renderEntry(item, "hint", undefined, "  Custom purpose  ")).toBe(
    "### `search`\nCustom purpose",
  )
  expect(renderEntry(item, "hint")).not.toContain("long first paragraph")
  expect(renderEntry(item, "hint")).not.toContain("Keep paths scoped.")
  expect(renderEntry(item, "name")).toBe("### `search`")

  const missing = tool("missing", "This is not a usable short description.")
  delete missing.promptSnippet
  expect(renderEntry(missing, "hint")).toBe(toolHeading("missing"))
  missing.promptSnippet = "   "
  expect(renderEntry(missing, "hint")).toBe(toolHeading("missing"))
})
test("configured hints override author snippets; tools without snippets degrade to Name", () => {
  const named = tool("named", "Detailed description for named.")
  named.promptSnippet = "Authored summary"
  const missing = tool("missing", "Description must not be summarized.")
  delete missing.promptSnippet
  const tools = [named, missing]
  const result = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      budget: 1000,
      rules: [
        { match: ["named"], level: "hint", hint: "Custom summary" },
        { match: ["missing"], level: "hint" },
      ],
    },
    options(tools),
  )
  const sections = readCatalog(result, tools).sections
  expect(sections.get("named")).toBe("### `named`\nCustom summary")
  expect(result).not.toContain(toolHeading("missing"))
  expect(result).toEndWith("Other available tools (inspect with `describeTool(name)`):\n`missing`")
  expect(result).not.toContain("Authored summary")
  expect(result).not.toContain("Description must not be summarized.")

  const budget = sectionCost(toolHeading("missing"))
  const automatic = createCatalog(
    native([missing]),
    { ...DEFAULT_CONFIG, budget, rules: [{ match: ["missing"], level: "auto" }] },
    options([missing]),
  )
  expect(readCatalog(automatic, [missing]).sections.get("missing")).toBe(toolHeading("missing"))
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
  expect(readCatalog(result, tools).sections.get("full")).toContain("declare const tools")
  expect(readCatalog(result, tools).sections.get("hint")).not.toContain("declare const tools")
  expect(result).not.toContain(toolHeading("name"))
  expect(result).toEndWith("Other available tools (inspect with `describeTool(name)`):\n`name`")
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

test("Auto covers tools with Hint before Full; omitted and fixed Full never become Hint", () => {
  const item = tool("search", "Description " + "x".repeat(300))
  const description = native([item])
  const hintCost = Math.ceil(renderEntry(item, "hint").length / 4)
  const config = {
    ...DEFAULT_CONFIG,
    budget: hintCost,
    rules: [{ match: ["search"], level: "auto" as const }],
  }
  expect(
    readCatalog(createCatalog(description, config, options([item])), [item]).sections.get("search"),
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
    readCatalog(createCatalog(description, { ...config, budget: nameCost }, options([item])), [
      item,
    ]).sections.get("search"),
  ).toBe(renderEntry(item, "name"))
  expect(
    readNativeCatalog(
      createCatalog(description, { ...config, budget: nameCost - 1 }, options([item])),
      [item],
    ).sections.size,
  ).toBe(0)

  const tools = [tool("a"), tool("b"), tool("c")]
  const hintBudget = tools.reduce((sum, item) => sum + sectionCost(renderEntry(item, "hint")), 0)
  const upgradeCost =
    sectionCost(renderEntry(tools[0]!, "full")) - sectionCost(renderEntry(tools[0]!, "hint"))
  for (const guarantee of ["none", "force", "global"]) {
    const layeredConfig = {
      ...DEFAULT_CONFIG,
      budget: hintBudget + upgradeCost - 1,
      exposeAllActiveTools: guarantee === "global",
      rules: tools.map((item) => ({
        match: [item.name],
        level: "auto" as const,
        priority: item.name === "a" ? 10 : 0,
        forceExpose: guarantee === "force",
      })),
    }
    const hints = readCatalog(
      createCatalog(native(tools), layeredConfig, options(tools)),
      tools,
    ).sections
    for (const item of tools) expect(hints.get(item.name)).toBe(renderEntry(item, "hint"))
    const upgraded = readCatalog(
      createCatalog(
        native(tools),
        { ...layeredConfig, budget: layeredConfig.budget + 1 },
        options(tools),
      ),
      tools,
    ).sections
    for (const [index, item] of tools.entries())
      expect(upgraded.get(item.name)).toBe(renderEntry(item, index === 0 ? "full" : "hint"))
  }
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
    const sections = readCatalog(result, tools).sections
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
  const result = readCatalog(createCatalog(native(tools), config, options(tools)), tools).sections
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
  const sections = readCatalog(createCatalog(native(tools), config, opts), tools).sections
  expect([...sections.keys()]).toEqual(["full", "hint"])
  expect(sections.get("full")).toBe(toolHeading("full"))
  expect(sections.get("hint")).toBe(toolHeading("hint"))
})
test("forced minima reserve budget before high-priority optional tools", () => {
  const forced = tool("forced"),
    optional = tool("optional"),
    tools = [optional, forced]
  const budget = Math.ceil(renderEntry(optional, "full").length / 4)
  const sections = readCatalog(
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
    expect([...readCatalog(result, tools).sections.keys()]).toEqual([mcp.name])
    expect(result).not.toContain("## mcp__docs")
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
    readCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
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

  const hintBudget = tools.reduce((sum, item) => sum + sectionCost(renderEntry(item, "hint")), 0)
  const upgradeCost = sectionCost(renderEntry(a, "full")) - sectionCost(renderEntry(a, "hint"))
  for (const boostPriority of [false, true]) {
    const sections = readNativeCatalog(
      createCatalog(
        native(tools),
        {
          ...DEFAULT_CONFIG,
          budget: hintBudget + 2 * upgradeCost,
          rules: tools.map((item) => ({
            match: [item.name],
            level: "auto" as const,
            priority: boostPriority && item.name === "b" ? 10 : 0,
          })),
        },
        options(tools),
      ),
      tools,
    ).sections
    for (const item of tools)
      expect(sections.get(item.name)).toBe(
        renderEntry(item, item.name === (boostPriority ? "c" : "b") ? "hint" : "full"),
      )
  }
})

test("Name-only catalogs omit empty nested tools and namespaces, including missing forced Hints", () => {
  const tools = [tool("ask_user_question"), tool("mcp__docs__search")]
  tools[0]!.promptSnippet = "   "
  delete tools[1]!.promptSnippet
  tools[1]!.namespace = { name: "mcp__docs", description: "Documentation" }
  for (const forceExpose of [false, true]) {
    const result = createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: forceExpose ? 0 : 1000,
        rules: tools.map((item) => ({ match: [item.name], level: "hint", forceExpose })),
      },
      options(tools),
    )
    expect(result).toBe(
      "Native execution instructions\n\nGlobals:\n- describeTool()\n\n" +
        "Other available tools (inspect with `describeTool(name)`):\n" +
        "`ask_user_question`, `mcp__docs__search`",
    )
  }
})

test("namespace listing counts include Names and compact names retain registration spelling", () => {
  const full = tool("full"),
    named = tool("raw-name"),
    hint = tool("hint"),
    absent = tool("absent")
  full.namespace = named.namespace = { name: "complete" }
  hint.namespace = absent.namespace = { name: "partial" }
  const tools = [named, full, hint, absent]
  const budget =
    sectionCost(renderEntry(full, "full")) +
    sectionCost(renderEntry(hint, "hint")) +
    sectionCost(renderEntry(named, "name"))
  const result = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      budget,
      rules: [
        { match: [named.name], level: "name", forceExpose: true },
        { match: [hint.name], level: "hint", forceExpose: true },
        { match: [full.name], level: "full", forceExpose: true },
      ],
    },
    options(tools),
  )
  expect(result).toContain("## complete\n")
  expect(result).not.toContain("## complete (some tools not listed)")
  expect(result).toContain("## partial (some tools not listed)")
  expect(result).not.toContain(toolHeading(named.name))
  expect(result).toEndWith("Other available tools (inspect with `describeTool(name)`):\n`raw-name`")
})

test("catalogs without Names omit the compact list, including Auto upgrades to Full", () => {
  const tools = [tool("full"), tool("hint"), tool("auto")]
  const result = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      rules: [
        { match: ["hint"], level: "hint" },
        { match: ["auto"], level: "auto" },
      ],
    },
    options(tools),
  )
  expect(result).not.toContain("Other available tools")
  expect(readNativeCatalog(result, tools).sections.get("auto")).toBe(renderEntry(tools[2]!, "full"))
  expect(readNativeCatalog(result, tools).sections.get("hint")).toBe(renderEntry(tools[1]!, "hint"))
})
