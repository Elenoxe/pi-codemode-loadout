import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, validateConfig } from "../src/config"
import { matches, resolveRule } from "../src/rules"

const tool = {
  name: "read",
  namespace: { name: "files" },
  sourceInfo: {
    source: "builtin",
    path: "builtin:read",
    scope: "user" as const,
    origin: "top-level" as const,
  },
}
test("exact selectors use AND, lists use OR and null is distinct from omitted namespace", () => {
  expect(matches(tool, { name: "read", source: "other" })).toBe(false)
  expect(matches(tool, { namespace: null })).toBe(false)
  expect(matches({ ...tool, namespace: undefined }, { namespace: null })).toBe(true)
  expect(resolveRule(tool, [{ match: ["bash", "read"], level: "name" }])?.level).toBe("name")
})
test("Name > Namespace > Source, matching selector specificity and earliest tie", () => {
  const rules = [
    { match: [{ source: "builtin" }], level: "hint" as const },
    { match: [{ namespace: "files", source: "builtin" }], level: "name" as const },
    { match: ["read"], level: "full" as const },
    { match: [{ name: "read", namespace: "files" }], level: "omit" as const },
    { match: [{ name: "read", namespace: "files" }], level: "auto" as const },
  ]
  expect(resolveRule(tool, rules)?.level).toBe("omit")
  expect(resolveRule(tool, rules.slice(0, 3))?.level).toBe("full")
  expect(
    resolveRule(tool, [
      { match: [{ name: "missing", namespace: "files" }, { source: "builtin" }], level: "omit" },
      rules[1]!,
    ])?.level,
  ).toBe("name")
})
test("invalid fields, wildcards, selectors and nonfinite values fail explicitly", () => {
  for (const value of [
    { rules: [{ match: ["read"], level: ["full"] }] },
    null,
    { extra: true },
    { budget: -1 },
    { budget: Infinity },
    { enabled: 1 },
    { rules: [{}] },
    { rules: [{ match: [] }] },
    { rules: [{ match: [{}] }] },
    { rules: [{ match: ["*"] }] },
    { rules: [{ match: [{ namespace: "mcp__*" }] }] },
    { rules: [{ match: ["read"], extra: true }] },
    { rules: [{ match: [{ name: "read", extra: true }] }] },
    { rules: [{ match: [""] }] },
    { rules: [{ match: [" \n\t"] }] },
    { rules: [{ match: [{ source: "*" }] }] },
    { rules: [{ match: ["read"], priority: Infinity }] },
    { budget: NaN },
    { rules: [{ match: ["read"], priority: NaN }] },
    { rules: [{ match: ["read"], level: "bad" }] },
  ])
    expect(() => validateConfig(value)).toThrow()
})
test("project fields override user fields; rules replace; untrusted project is not read", () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-config-"))
  try {
    const agent = join(root, "agent"),
      cwd = join(root, "project")
    mkdirSync(agent)
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(
      join(agent, "codemode-tool-catalog.json"),
      JSON.stringify({ budget: 123, rules: [{ match: ["read"] }] }),
    )
    writeFileSync(
      join(cwd, ".pi", "codemode-tool-catalog.json"),
      JSON.stringify({ enabled: false, rules: [] }),
    )
    expect(loadConfig(agent, cwd, true)).toEqual({
      enabled: false,
      budget: 123,
      exposeAllActiveTools: false,
      rules: [],
    })
    expect(loadConfig(agent, cwd, false).rules).toHaveLength(1)
    writeFileSync(join(cwd, ".pi", "codemode-tool-catalog.json"), "{broken")
    expect(() => loadConfig(agent, cwd, true)).toThrow("invalid JSON")
    expect(() => loadConfig(agent, cwd, false)).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
