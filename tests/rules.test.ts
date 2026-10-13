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
  expect(resolveRule(tool, [{ match: ["bash", "read"], maxLevel: "name" }])?.maxLevel).toBe("name")
})
test("Name > Namespace > Source, matching selector specificity and earliest tie", () => {
  const rules = [
    { match: [{ source: "builtin" }], maxLevel: "hint" as const },
    { match: [{ namespace: "files", source: "builtin" }], maxLevel: "name" as const },
    { match: ["read"], maxLevel: "full" as const },
    { match: [{ name: "read", namespace: "files" }], maxLevel: "omit" as const },
    { match: [{ name: "read", namespace: "files" }], maxLevel: "full" as const },
  ]
  expect(resolveRule(tool, rules)?.maxLevel).toBe("omit")
  expect(resolveRule(tool, rules.slice(0, 3))?.maxLevel).toBe("full")
  expect(
    resolveRule(tool, [
      { match: [{ name: "missing", namespace: "files" }, { source: "builtin" }], maxLevel: "omit" },
      rules[1]!,
    ])?.maxLevel,
  ).toBe("name")
})
test("invalid fields, wildcards, selectors and nonfinite values fail explicitly", () => {
  for (const value of [
    { rules: [{ match: ["read"], maxLevel: ["full"] }] },
    { rules: [{ match: ["read"], level: "full" }] },
    { rules: [{ match: ["read"], forceExpose: true }] },
    { rules: [{ match: ["read"], maxLevel: "auto" }] },
    { rules: [{ match: ["read"], minLevel: "omit" }] },
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
    { rules: [{ match: ["read"], maxLevel: "bad" }] },
    { rules: [{ match: ["read"], hint: 12 }] },
  ])
    expect(() => validateConfig(value)).toThrow()
})
test("valid ranges are preserved; inverted ranges report an error and discard both bounds", () => {
  const levels = ["name", "hint", "full"] as const
  for (const [minimum, minLevel] of levels.entries()) {
    for (const [maximum, maxLevel] of levels.entries()) {
      const rule = { match: ["read"], minLevel, maxLevel, priority: 100, hint: "Read files" }
      const config = { rules: [rule] }
      const errors: string[] = []
      const result = validateConfig(config, "catalog.json", (message) => errors.push(message))
      if (minimum > maximum) {
        expect(result.rules).toEqual([{ match: ["read"], priority: 100, hint: "Read files" }])
        expect(errors).toEqual([
          "catalog.json/rules/0/minLevel: exceeds maxLevel; ignoring both level bounds",
        ])
        expect(config.rules[0]).toEqual(rule)
      } else {
        expect(result).toEqual(config)
        expect(errors).toEqual([])
      }
    }
    expect(validateConfig({ rules: [{ match: ["read"], minLevel }] })).toEqual({
      rules: [{ match: ["read"], minLevel }],
    })
  }
  const errors: string[] = []
  expect(
    validateConfig(
      {
        rules: [{ match: ["read"], minLevel: "name", maxLevel: "omit" }],
      },
      "catalog.json",
      (message) => errors.push(message),
    ).rules,
  ).toEqual([{ match: ["read"] }])
  expect(errors).toHaveLength(1)
  expect(validateConfig({ rules: [{ match: ["read"], maxLevel: "omit" }] })).toEqual({
    rules: [{ match: ["read"], maxLevel: "omit" }],
  })
})

test("custom Hint accepts blank content and warns without rejecting broad selectors", () => {
  expect(validateConfig({ rules: [{ match: ["read"], hint: "Read files" }] })).toEqual({
    rules: [{ match: ["read"], hint: "Read files" }],
  })
  expect(
    validateConfig({
      rules: [{ match: [{ name: "read", source: "builtin" }], hint: "Read source files" }],
    }),
  ).toEqual({
    rules: [{ match: [{ name: "read", source: "builtin" }], hint: "Read source files" }],
  })
  for (const hint of ["", "   "]) {
    const config = { rules: [{ match: ["read"], hint }] }
    expect(validateConfig(config)).toEqual(config)
  }
  for (const match of [["read", "edit"], [{ namespace: "files" }], [{ source: "builtin" }]]) {
    const config = { rules: [{ match, hint: "Shared summary" }] }
    const diagnostics: unknown[] = []
    expect(
      validateConfig(config, "catalog.json", (message, severity) =>
        diagnostics.push({ message, severity }),
      ),
    ).toEqual(config)
    expect(diagnostics).toEqual([
      {
        message: "catalog.json/rules/0/hint: applies to multiple tools or a non-named selector",
        severity: "warning",
      },
    ])
  }
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
