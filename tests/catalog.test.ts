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
