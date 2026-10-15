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
const NAME_LIST_HEADER = "Other available tools (inspect with `describeTool(name)`):\n"
const nameList = (names: string[]) =>
  NAME_LIST_HEADER + names.map((name) => `\`${name}\``).join(", ")
// Recover displayed entries for allocation assertions.
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

test("minimum Hint uses valid content; missing content reports and becomes minimum Name", () => {
  const item = tool("search")
  const config = {
    ...DEFAULT_CONFIG,
    budget: 0,
    rules: [{ match: [item.name], minLevel: "hint" as const }],
  }
  expect(
    readCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
      item.name,
    ),
  ).toBe(renderEntry(item, "hint"))
  for (const hint of ["", "   "]) {
    const errors: string[] = []
    const sections = readCatalog(
      createCatalog(
        native([item]),
        {
          ...config,
          budget: 10000,
          rules: [{ match: [item.name], minLevel: "hint", maxLevel: "hint", hint }],
        },
        {
          ...options([item]),
          reportDiagnostic: (message) => errors.push(message),
        },
      ),
      [item],
    ).sections
    expect(sections.get(item.name)).toBe(toolHeading(item.name))
    expect(errors).toEqual([])
  }
  for (const snippet of [undefined, "", "  "]) {
    item.promptSnippet = snippet
    for (const maxLevel of [undefined, "hint" as const]) {
      const errors: string[] = []
      const sections = readCatalog(
        createCatalog(
          native([item]),
          {
            ...config,
            rules: [{ match: [item.name], minLevel: "hint", maxLevel }],
          },
          {
            ...options([item]),
            reportDiagnostic: (message) => errors.push(message),
          },
        ),
        [item],
      ).sections
      expect(sections.get(item.name)).toBe(toolHeading(item.name))
      expect(errors).toEqual([
        'Tool search: minLevel "hint" has no non-empty hint or promptSnippet; using minimum Name',
      ])
      const expanded = readCatalog(
        createCatalog(
          native([item]),
          {
            ...config,
            budget: 10000,
            rules: [{ match: [item.name], minLevel: "hint", maxLevel }],
          },
          {
            ...options([item]),
            reportDiagnostic: () => {},
          },
        ),
        [item],
      ).sections
      expect(expanded.get(item.name)).toBe(
        maxLevel === "hint" ? toolHeading(item.name) : renderEntry(item, "full"),
      )
    }
    const overridden = {
      ...config,
      rules: [{ match: [item.name], minLevel: "hint" as const, hint: "Custom summary" }],
    }
    expect(
      readCatalog(createCatalog(native([item]), overridden, options([item])), [item]).sections.get(
        item.name,
      ),
    ).toBe("### `search`\nCustom summary")
  }
  expect(() =>
    createCatalog(
      native([item]),
      {
        ...config,
        rules: [{ match: [item.name], minLevel: "full" }],
      },
      options([item]),
    ),
  ).not.toThrow()
})

test("ceilings cap automatic upgrades and hard minima do not cap them", () => {
  const item = tool("search")
  for (const maxLevel of ["name", "hint", "full"] as const) {
    const config = { ...DEFAULT_CONFIG, budget: 10000, rules: [{ match: [item.name], maxLevel }] }
    expect(
      readCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
        item.name,
      ),
    ).toBe(renderEntry(item, maxLevel))
  }
  for (const minLevel of ["name", "hint"] as const) {
    const config = { ...DEFAULT_CONFIG, budget: 10000, rules: [{ match: [item.name], minLevel }] }
    expect(
      readCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
        item.name,
      ),
    ).toBe(renderEntry(item, "full"))
  }
})

test("upgrades use incremental rather than total Full costs and continue after oversized Full", () => {
  const expensive = tool("expensive", "x".repeat(300))
  const cheap = tool("cheap")
  expensive.promptSnippet = "x".repeat(400)
  const tools = [cheap, expensive]
  const coverageCost = tools.reduce((sum, item) => sum + sectionCost(renderEntry(item, "hint")), 0)
  const delta =
    sectionCost(renderEntry(expensive, "full")) - sectionCost(renderEntry(expensive, "hint"))
  expect(delta).toBeLessThan(
    sectionCost(renderEntry(cheap, "full")) - sectionCost(renderEntry(cheap, "hint")),
  )
  const sections = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: coverageCost + delta,
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(sections.get("expensive")).toBe(renderEntry(expensive, "full"))
  expect(sections.get("cheap")).toBe(renderEntry(cheap, "hint"))

  const huge = tool("huge", "x".repeat(2000))
  const small = tool("small")
  const budget = sectionCost(renderEntry(huge, "hint")) + sectionCost(renderEntry(small, "full"))
  const continued = readCatalog(
    createCatalog(
      native([huge, small]),
      {
        ...DEFAULT_CONFIG,
        budget,
      },
      options([huge, small]),
    ),
    [huge, small],
  ).sections
  expect(continued.get("huge")).toBe(renderEntry(huge, "hint"))
  expect(continued.get("small")).toBe(renderEntry(small, "full"))
})

test("already-maximal minima do not consume namespace upgrade turns", () => {
  const fixed = tool("fixed"),
    first = tool("first"),
    second = tool("second")
  second.namespace = { name: "server" }
  const tools = [fixed, first, second]
  const budget =
    sectionCost(renderEntry(fixed, "full")) +
    sectionCost(renderEntry(first, "full")) +
    sectionCost(renderEntry(second, "hint"))
  const sections = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget,
        rules: [{ match: ["fixed"], minLevel: "full" }],
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(sections.get("fixed")).toBe(renderEntry(fixed, "full"))
  expect(sections.get("first")).toBe(renderEntry(first, "full"))
  expect(sections.get("second")).toBe(renderEntry(second, "hint"))
})

test("Full preserves native declarations and renders output types and input constraints", () => {
  const item = tool("search")
  expect(renderEntry(item, "full", "original exact bytes")).toBe("original exact bytes")
  expect(renderEntry(item, "full")).toContain("Keep paths scoped.")
  expect(renderEntry(item, "full")).toContain("Promise<unknown>")
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
        { match: ["named"], maxLevel: "hint", hint: "Custom summary" },
        { match: ["missing"], maxLevel: "hint" },
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

  const budget = sectionCost(nameList(["missing"]))
  const automatic = createCatalog(
    native([missing]),
    { ...DEFAULT_CONFIG, budget, rules: [{ match: ["missing"] }] },
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
        maxLevel: t.name as "full" | "hint" | "name" | "omit",
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

test("default allocation covers Hint, then Full, with Name and omission at tight budgets", () => {
  const item = tool("search", "Description " + "x".repeat(300))
  const description = native([item])
  const hintCost = Math.ceil(renderEntry(item, "hint").length / 4)
  const config = {
    ...DEFAULT_CONFIG,
    budget: hintCost,
    rules: [{ match: ["search"] }],
  }
  expect(
    readCatalog(createCatalog(description, config, options([item])), [item]).sections.get("search"),
  ).toBe(renderEntry(item, "hint"))
  for (const rules of [[], [{ match: ["search"] }], [{ match: ["search"], priority: 100 }]]) {
    expect(
      readCatalog(createCatalog(description, { ...config, rules }, options([item])), [
        item,
      ]).sections.get("search"),
    ).toBe(renderEntry(item, "hint"))
  }
  expect(
    readCatalog(
      createCatalog(
        description,
        { ...config, rules: [{ match: ["search"], minLevel: "full" }] },
        options([item]),
      ),
      [item],
    ).sections.get("search"),
  ).toBe(renderEntry(item, "full"))
  item.promptSnippet = "Long authored summary. ".repeat(10)
  const nameCost = sectionCost(nameList([item.name]))
  expect(
    readCatalog(createCatalog(description, { ...config, budget: nameCost }, options([item])), [
      item,
    ]).sections.get("search"),
  ).toBe(renderEntry(item, "name"))
  expect(
    readCatalog(createCatalog(description, { ...config, budget: nameCost - 1 }, options([item])), [
      item,
    ]).sections.size,
  ).toBe(0)

  const tools = [tool("a"), tool("b"), tool("c")]
  const fullCost = sectionCost(renderEntry(tools[0]!, "full"))
  for (const guarantee of ["none", "minimum", "global"]) {
    const config = {
      ...DEFAULT_CONFIG,
      budget: fullCost + (guarantee === "none" ? 0 : sectionCost(nameList(["b", "c"]))),
      exposeAllActiveTools: guarantee === "global",
      rules: tools.map((item) => ({
        match: [item.name],
        priority: item.name === "a" ? 10 : 0,
        minLevel: guarantee === "minimum" ? ("name" as const) : undefined,
      })),
    }
    const sections = readCatalog(
      createCatalog(native(tools), config, options(tools)),
      tools,
    ).sections
    expect(sections.get("a")).toBe(renderEntry(tools[0]!, "full"))
    for (const item of tools.slice(1)) {
      expect(sections.get(item.name)).toBe(
        guarantee === "none" ? undefined : toolHeading(item.name),
      )
    }
  }
})
test("priority upgrades precede lower coverage; cheapest increments win within a namespace", () => {
  const big = tool("big", "x".repeat(500)),
    small = tool("small"),
    ns = tool("ns")
  ns.namespace = { name: "server", description: "Server tools" }
  const tools = [big, small, ns]
  const bigCost = sectionCost(renderEntry(big, "full"))
  const prioritized = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      budget: bigCost,
      rules: [{ match: ["big"], priority: 200 }],
    },
    options(tools),
  )
  expect([...readCatalog(prioritized, tools).sections.keys()]).toEqual(["big"])
  const hintBudget = tools.reduce((sum, item) => sum + sectionCost(renderEntry(item, "hint")), 0)
  const increment =
    sectionCost(renderEntry(small, "full")) - sectionCost(renderEntry(small, "hint"))
  const sections = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: hintBudget + increment,
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(sections.get("small")).toBe(renderEntry(small, "full"))
  expect(sections.get("big")).toBe(renderEntry(big, "hint"))
  expect(sections.get("ns")).toBe(renderEntry(ns, "hint"))
  const negative = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: hintBudget + increment,
        rules: [{ match: ["small"], priority: -1 }],
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(negative.get("ns")).toBe(renderEntry(ns, "full"))
  expect(negative.get("big")).toBe(renderEntry(big, "hint"))
  expect(negative.get("small")).toBe(renderEntry(small, "hint"))
})
test("shared budget charges actual entry text and is deterministic across boundaries", () => {
  const tools = [tool("a"), tool("b"), tool("c", "x".repeat(500))]
  for (let budget = 0; budget < 300; budget += 7) {
    const config = { ...DEFAULT_CONFIG, budget, rules: [{ match: ["c"] }] }
    const result = createCatalog(native(tools), config, options(tools))
    const [declarations, names] = result.split("\n\n" + NAME_LIST_HEADER)
    const sections = readNativeCatalog(declarations!, tools).sections
    expect(
      [...sections.values()].reduce((sum, text) => sum + sectionCost(text), 0) +
        (names ? sectionCost(NAME_LIST_HEADER + names) : 0),
    ).toBeLessThanOrEqual(budget)
    expect(createCatalog(native(tools), config, options(tools))).toBe(result)
  }
  const inherited = createCatalog(
    native(tools),
    { ...DEFAULT_CONFIG, rules: [{ match: ["a"], maxLevel: "full" }] },
    options(tools, 0),
  )
  expect(readNativeCatalog(inherited, tools).sections.size).toBe(0)
})

test("hard minima and fixed formats exceed budget; Omit excludes even globally guaranteed tools", () => {
  const tools = [tool("full"), tool("hint"), tool("name"), tool("ordinary"), tool("omit")]
  const result = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: 0,
        exposeAllActiveTools: true,
        rules: [
          { match: ["full"], minLevel: "full" },
          { match: ["hint"], minLevel: "hint", maxLevel: "hint" },
          { match: ["name"], minLevel: "name", maxLevel: "name" },
          { match: ["omit"], maxLevel: "omit" },
        ],
      },
      options(tools),
    ),
    tools,
  ).sections
  expect(result.get("full")).toBe(renderEntry(tools[0]!, "full"))
  expect(result.get("hint")).toBe(renderEntry(tools[1]!, "hint"))
  expect(result.get("name")).toBe(toolHeading("name"))
  expect(result.get("ordinary")).toBe(toolHeading("ordinary"))
  expect(result.has("omit")).toBe(false)
})
test("reserved content upgrades using only the cost difference", () => {
  const item = tool("search"),
    description = native([item])
  delete item.promptSnippet
  const fullCost = Math.ceil(renderEntry(item, "full").length / 4)
  const result = createCatalog(
    description,
    {
      ...DEFAULT_CONFIG,
      budget: fullCost,
      rules: [{ match: ["search"], minLevel: "name" }],
    },
    options([item]),
  )
  expect(readNativeCatalog(result, [item]).sections.get("search")).toBe(renderEntry(item, "full"))

  const tools = [tool("a"), tool("b")]
  for (const entry of tools) delete entry.promptSnippet
  const budget = sectionCost(renderEntry(tools[0]!, "full")) + sectionCost(nameList(["b"]))
  const config = {
    ...DEFAULT_CONFIG,
    budget,
    exposeAllActiveTools: true,
    rules: tools.map((entry) => ({
      match: [entry.name],
      priority: entry.name === "a" ? 10 : 0,
    })),
  }
  const mixed = createCatalog(native(tools), config, options(tools))
  expect(readCatalog(mixed, tools).sections.get("a")).toBe(renderEntry(tools[0]!, "full"))
  expect(mixed).toEndWith(nameList(["b"]))
  expect(createCatalog(native(tools), { ...config, budget: budget - 1 }, options(tools))).toEndWith(
    nameList(["a", "b"]),
  )
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
      { match: ["full"], maxLevel: "full" as const },
      { match: ["hint"], maxLevel: "hint" as const },
      { match: ["omit"], maxLevel: "omit" as const },
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
  const budget = sectionCost(nameList(["forced"])) - 1
  const sections = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget,
        rules: [
          { match: ["forced"], minLevel: "name" },
          { match: ["optional"], maxLevel: "full", priority: 1000 },
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
        minLevel: "full" as const,
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
    [{ match: [mcp.name], maxLevel: "full" as const }],
    [{ match: [mcp.name], maxLevel: "hint" as const }],
    [{ match: [mcp.name], maxLevel: "name" as const }],
    [{ match: [mcp.name], hint: "Search documentation" }],
    [{ match: [{ namespace: "mcp__docs" }], maxLevel: "full" as const }],
    [{ match: [{ source: "builtin" }], maxLevel: "hint" as const }],
    [{ match: [{ namespace: null }], maxLevel: "hint" as const }],
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
      { ...DEFAULT_CONFIG, budget: 0, rules: [{ match, minLevel: "name" }] },
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
        { ...DEFAULT_CONFIG, rules: [{ match: [mcp.name], minLevel: "full" }] },
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
    { ...DEFAULT_CONFIG, rules: [{ match: ["b"], maxLevel: "omit" }] },
    options(tools),
  )
  expect(readNativeCatalog(result, tools).sections.get("a")).toBe(renderEntry(a, "full"))
})

test("Name minimum can upgrade to Hint and source selectors can explicitly select MCP", () => {
  const item = tool("search", "x".repeat(500))
  const config = {
    ...DEFAULT_CONFIG,
    budget: 100,
    rules: [{ match: [item.name], minLevel: "name" as const }],
  }
  expect(
    readCatalog(createCatalog(native([item]), config, options([item])), [item]).sections.get(
      item.name,
    ),
  ).toBe(renderEntry(item, "hint"))
  const mcp = tool("mcp__docs__search")
  mcp.exposure = "deferred"
  mcp.sourceInfo.source = "npm:docs-adapter"
  const result = createCatalog(
    "intro",
    {
      ...DEFAULT_CONFIG,
      rules: [{ match: [{ source: "npm:docs-adapter" }], minLevel: "name", maxLevel: "hint" }],
    },
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
  const coverageBudget = sectionCost(renderEntry(a, "hint")) + sectionCost(renderEntry(c, "hint"))
  const covered = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: coverageBudget,
        rules: [{ match: [{ source: "test" }], maxLevel: "hint" }],
      },
      options(tools),
    ),
    tools,
  ).sections
  expect([...covered.keys()]).toEqual(["a", "c"])

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

test("Name-only catalogs omit empty groups when optional Hints are missing", () => {
  const tools = [tool("ask_user_question"), tool("mcp__docs__search")]
  tools[0]!.promptSnippet = "   "
  delete tools[1]!.promptSnippet
  tools[1]!.namespace = { name: "mcp__docs", description: "Documentation" }
  for (const guaranteed of [false, true]) {
    const result = createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: guaranteed ? 0 : 1000,
        rules: tools.map((item) => ({
          match: [item.name],
          maxLevel: "hint",
          minLevel: guaranteed ? "name" : undefined,
        })),
      },
      options(tools),
    )
    expect(result).toBe(
      "Native execution instructions\n\nGlobals:\n- describeTool()\n\n" +
        "Other available tools (inspect with `describeTool(name)`):\n" +
        "`ask_user_question`, `mcp__docs__search`",
    )
  }

  const budget = sectionCost(nameList(tools.map((entry) => entry.name)))
  for (const level of ["name", "hint"] as const) {
    const config = {
      ...DEFAULT_CONFIG,
      budget,
      rules: tools.map((entry) => ({ match: [entry.name], level })),
    }
    expect(createCatalog(native(tools), config, options(tools))).toEndWith(
      nameList(tools.map((entry) => entry.name)),
    )
    expect(
      createCatalog(native(tools), { ...config, budget: budget - 1 }, options(tools)),
    ).toEndWith(nameList([tools[0]!.name]))
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
    sectionCost(nameList([named.name]))
  const result = createCatalog(
    native(tools),
    {
      ...DEFAULT_CONFIG,
      budget,
      rules: [
        { match: [named.name], minLevel: "name", maxLevel: "name" },
        { match: [hint.name], minLevel: "hint", maxLevel: "hint" },
        { match: [full.name], minLevel: "full" },
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
      rules: [{ match: ["hint"], maxLevel: "hint" }, { match: ["auto"] }],
    },
    options(tools),
  )
  expect(result).not.toContain("Other available tools")
  expect(readNativeCatalog(result, tools).sections.get("auto")).toBe(renderEntry(tools[2]!, "full"))
  expect(readNativeCatalog(result, tools).sections.get("hint")).toBe(renderEntry(tools[1]!, "hint"))
})

test("same-priority Name coverage precedes Hint, and all Hints precede Full", () => {
  const tools = [tool("a"), tool("b"), tool("c")]
  for (const item of tools) item.promptSnippet = "x".repeat(100)
  const namesBudget = sectionCost(nameList(tools.map((item) => item.name)))
  const names = readCatalog(
    createCatalog(native(tools), { ...DEFAULT_CONFIG, budget: namesBudget }, options(tools)),
    tools,
  ).sections
  for (const item of tools) expect(names.get(item.name)).toBe(toolHeading(item.name))

  const hintBudget = tools.reduce((sum, item) => sum + sectionCost(renderEntry(item, "hint")), 0)
  const hints = readCatalog(
    createCatalog(
      native(tools),
      {
        ...DEFAULT_CONFIG,
        budget: hintBudget,
        rules: [{ match: [{ source: "test" }], minLevel: "name" }],
      },
      options(tools),
    ),
    tools,
  ).sections
  for (const item of tools) expect(hints.get(item.name)).toBe(renderEntry(item, "hint"))
})

for (const target of ["name", "hint", "full"] as const) {
  test(`${target} independently sorts incremental costs and round-robins namespaces`, () => {
    const a = tool("a", "x".repeat(500))
    const b = tool("bbbb", "x".repeat(600))
    const c = tool("cccccccc", "x".repeat(800))
    a.promptSnippet = "x".repeat(100)
    b.promptSnippet = "x".repeat(104)
    c.promptSnippet = "x".repeat(140)
    c.namespace = { name: "server" }
    const tools = [b, c, a]
    const minimum = target === "name" ? undefined : target === "hint" ? "name" : "hint"
    const budget =
      target === "name"
        ? sectionCost(nameList([a.name, c.name]))
        : sectionCost(renderEntry(a, target)) +
          sectionCost(renderEntry(c, target)) +
          (minimum === "name"
            ? sectionCost(nameList([b.name]))
            : sectionCost(renderEntry(b, "hint")))
    const sections = readCatalog(
      createCatalog(
        native(tools),
        {
          ...DEFAULT_CONFIG,
          budget,
          rules: [{ match: [{ source: "test" }], minLevel: minimum, maxLevel: target }],
        },
        options(tools),
      ),
      tools,
    ).sections
    expect(sections.get(a.name)).toBe(renderEntry(a, target))
    expect(sections.get(c.name)).toBe(renderEntry(c, target))
    expect(sections.get(b.name)).toBe(minimum ? renderEntry(b, minimum) : undefined)
  })
}

test("failed Name allocation still permits direct Hint or Full allocation", () => {
  for (const target of ["hint", "full"] as const) {
    const item = tool("a")
    if (target === "full") delete item.promptSnippet
    const full = toolHeading(item.name) + "\nTiny native declaration"
    const description = "intro\n\nNested tools:\n\n" + full
    const expected = target === "full" ? full : renderEntry(item, "hint")
    const budget = sectionCost(expected)
    expect(budget).toBeLessThan(sectionCost(nameList([item.name])))
    const result = createCatalog(
      description,
      { ...DEFAULT_CONFIG, budget, rules: [{ match: [item.name], maxLevel: target }] },
      options([item]),
    )
    expect(readCatalog(result, [item]).sections.get(item.name)).toBe(expected)
    expect(result).not.toContain(NAME_LIST_HEADER)
  }
})
