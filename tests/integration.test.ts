import { getModel } from "@earendil-works/pi-ai/compat"
import { expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { updateCodemodeDescription } from "../src/index"

const system = (description: string): AgentMessage => ({
  role: "system",
  content: "",
  timestamp: 1,
  toolsAdded: [{ name: "codemode", description, parameters: { type: "object" } }],
})

test("replays additions and removals without mutating the transcript", () => {
  const messages = [system("first"), system("latest")]
  const snapshot = structuredClone(messages)
  const result = updateCodemodeDescription(messages, (text) => text + " changed")
  expect(result[0]).toBe(messages[0])
  expect(result[1]?.role === "system" && result[1].toolsAdded?.[0]?.description).toBe(
    "latest changed",
  )
  expect(messages).toEqual(snapshot)
  const removed: AgentMessage = {
    role: "system",
    content: "",
    timestamp: 2,
    toolsRemoved: [{ name: "codemode" }],
  }
  expect(updateCodemodeDescription([...messages, removed], () => "changed")).toEqual([
    ...messages,
    removed,
  ])
  expect(
    updateCodemodeDescription([...messages, removed, system("readded")], () => "changed").at(-1),
  ).toMatchObject({ toolsAdded: [{ description: "changed" }] })
})

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai"
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  type ExtensionAPI,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import catalogExtension from "../src/index"

export async function withSession(
  config: unknown,
  mode: "on" | "only",
  run: (
    session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    requests: Message[][],
    control: { pi: ExtensionAPI; root: string; script: (code: string) => void },
  ) => Promise<void>,
  projectTrusted = true,
) {
  const root = mkdtempSync(join(tmpdir(), "catalog-integration-"))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const requests: Message[][] = []
  let api: ExtensionAPI | undefined
  let pendingCode: string | undefined
  const settings = SettingsManager.inMemory({
    codemode: { mode, inlineBudget: 10000 },
    defaultTools: ["read", "bash", "edit", "write", "codemode"],
    compaction: { enabled: false },
    retry: { enabled: false },
  })
  settings.setProjectTrusted(projectTrusted)
  const model = {
    ...getModel("openai", "gpt-4o-mini"),
    provider: "catalog-test",
    api: "catalog-test-api",
  }
  mkdirSync(join(root, "workspace"))
  if (config !== undefined)
    writeFileSync(join(root, "codemode-tool-catalog.json"), JSON.stringify(config))
  const loader = new DefaultResourceLoader({
    cwd: join(root, "workspace"),
    agentDir: root,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension(),
      catalogExtension,
      createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
      (pi) => {
        api = pi
        pi.registerProvider("catalog-test", {
          baseUrl: "http://unused.invalid",
          api: "catalog-test-api",
          apiKey: "test-only",
          streamSimple: (model, context) => {
            requests.push(structuredClone(context.messages))
            const stream = createAssistantMessageEventStream()
            const code = pendingCode
            pendingCode = undefined
            const message: AssistantMessage = {
              role: "assistant",
              content: code
                ? [
                    {
                      type: "toolCall",
                      id: "call-" + requests.length,
                      name: "codemode",
                      arguments: { code },
                    },
                  ]
                : [{ type: "text", text: "ok" }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: code ? "toolUse" : "stop",
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }
            stream.push({ type: "done", reason: code ? "toolUse" : "stop", message })
            return stream
          },
        })
      },
    ],
  })
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
  try {
    await loader.reload()
    const result = await createAgentSession({
      cwd: join(root, "workspace"),
      agentDir: root,
      model,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(join(root, "workspace")),
    })
    session = result.session
    const errors: string[] = []
    await session.bindExtensions({ onError: (error) => errors.push(error.error) })
    await run(session, requests, {
      pi: api!,
      root,
      script: (code) => {
        pendingCode = code
      },
    })
    expect(errors).toEqual([])
  } finally {
    session?.dispose()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test("real Pi requests omit catalog entries without changing runtime or stored history", async () => {
  await withSession(
    { rules: [{ match: ["read"], level: "omit" }] },
    "only",
    async (session, requests) => {
      const original = session.getToolDefinition("codemode")
      await session.prompt("one")
      await session.prompt("two")
      for (const messages of requests) {
        const description = getCurrentTools(messages).find(
          (tool) => tool.name === "codemode",
        )!.description
        expect(description).not.toContain("### `read`")
        expect(description).toContain("### `bash`")
      }
      expect(session.getCallableToolNames()).toContain("read")
      expect(session.getToolDefinition("codemode")).toBe(original)
      const stored = session.sessionManager.buildSessionContext().messages
      expect(
        getCurrentTools(stored).find((tool) => tool.name === "codemode")!.description,
      ).toContain("### `read`")
    },
  )
})

test("zero configuration preserves the native description byte-for-byte", async () => {
  await withSession(undefined, "only", async (session, requests) => {
    await session.prompt("one")
    const stored = session.sessionManager.buildSessionContext().messages
    expect(
      getCurrentTools(requests[0]!).find((tool) => tool.name === "codemode")!.description,
    ).toBe(getCurrentTools(stored).find((tool) => tool.name === "codemode")!.description)
  })
})

test("native Codemode still executes omitted tools and all discovery APIs", async () => {
  await withSession(
    { rules: [{ match: ["read"], level: "omit" }] },
    "only",
    async (session, requests, { script, root }) => {
      writeFileSync(join(root, "workspace", "sample.txt"), "real file content")
      script(
        'text(await tools.read({path:"sample.txt"})); text(await describeTool("read")); text((await searchTools("read file")).some(t=>t.name==="read")); text(ALL_TOOLS.some(t=>t.name==="read")); text(await describeNamespace("missing"));',
      )
      await session.prompt("execute native script")
      const results = session.messages.filter((message) => message.role === "toolResult")
      expect(results).toHaveLength(1)
      expect(JSON.stringify(results)).toContain("real file content")
      expect(JSON.stringify(results)).toContain("declare const tools")
      expect(JSON.stringify(results)).toContain("Script completed")
      expect(JSON.stringify(results)).not.toContain("Script failed")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("### `read`")
    },
  )
})

test("on mode never duplicates Direct declarations, including force and global guarantees", async () => {
  await withSession(
    {
      budget: 0,
      exposeAllActiveTools: true,
      rules: [{ match: ["read"], level: "full", forceExpose: true }],
    },
    "on",
    async (session, requests) => {
      await session.prompt("on")
      const tools = getCurrentTools(requests[0]!)
      expect(tools.some((t) => t.name === "read")).toBe(true)
      expect(tools.find((t) => t.name === "codemode")!.description).not.toContain("### `read`")
    },
  )
})

test("dynamic activation, removal, reactivation and reload use current native state", async () => {
  await withSession(
    { budget: 0, exposeAllActiveTools: true },
    "only",
    async (session, requests, { root }) => {
      await session.prompt("initial")
      session.setActiveToolsByName(["bash", "codemode"])
      await session.prompt("changed")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("### `read`")
      session.setActiveToolsByName(["bash"])
      await session.prompt("removed")
      expect(getCurrentTools(requests.at(-1)!).some((t) => t.name === "codemode")).toBe(false)
      session.setActiveToolsByName(["read", "bash", "codemode"])
      await session.prompt("readded")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).toContain("### `read`")
      writeFileSync(join(root, "codemode-tool-catalog.json"), JSON.stringify({ enabled: false }))
      await session.prompt("not yet reloaded")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("declare const tools")
      await session.reload()
      await session.prompt("reloaded")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).toContain("declare const tools")
    },
  )
})

const mcpServer = String.raw`
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === "initialize") result = {protocolVersion:request.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:"catalog-test",version:"1"},instructions:"Search documentation"};
    else if (request.method === "tools/list") result = {tools:[{name:"search",description:"Search documentation.",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]},outputSchema:{type:"object",properties:{answer:{type:"string"}}}}]};
    else if (request.method === "tools/call") result = {content:[{type:"text",text:request.params.arguments.query}],structuredContent:{answer:request.params.arguments.query}};
    else if (request.method === "ping") result = {};
    else {process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"Unknown method"}})+"\n");continue;}
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\n");
  }
});
`

test("late-connected real stdio MCP stays Deferred but can be explicitly listed and called", async () => {
  await withSession(
    {
      budget: 0,
      rules: [{ match: [{ namespace: "mcp__docs" }], level: "hint", forceExpose: true }],
    },
    "only",
    async (session, requests, { pi, script }) => {
      await session.prompt("before connection")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("mcp__docs__search")
      pi.registerMcpServer("docs", {
        command: "node",
        args: ["-e", mcpServer],
        exposure: "codemode",
      })
      script(
        'text(await tools.mcp__docs__search({query:"actual MCP call"})); text(await describeNamespace("mcp__docs"));',
      )
      await session.prompt("connect and execute")
      expect(JSON.stringify(session.messages)).toContain("actual MCP call")
      expect(JSON.stringify(session.messages)).not.toContain("Script failed")
      const description = getCurrentTools(requests.at(-1)!).find(
        (t) => t.name === "codemode",
      )!.description
      expect(description).toContain("### `mcp__docs__search`\nSearch documentation.")
      expect(description).not.toContain("mcp__docs__search(args:")
      expect(session.getAllTools().find((t) => t.name === "mcp__docs__search")!.exposure).toBe(
        "deferred",
      )
      expect(session.getActiveToolNames()).not.toContain("mcp__docs__search")
      pi.unregisterMcpServer("docs")
      await session.prompt("after withdrawal")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("### `mcp__docs__search`")
    },
  )
}, 20000)

test("trusted project config overrides user fields on reload without merging rules", async () => {
  await withSession(
    { budget: 0, exposeAllActiveTools: true, rules: [{ match: ["read"], level: "omit" }] },
    "only",
    async (session, requests, { root }) => {
      await session.prompt("user config")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).not.toContain("### `read`")
      mkdirSync(join(root, "workspace", ".pi"), { recursive: true })
      writeFileSync(
        join(root, "workspace", ".pi", "codemode-tool-catalog.json"),
        JSON.stringify({ rules: [{ match: ["bash"], level: "omit" }] }),
      )
      await session.reload()
      await session.prompt("project override")
      const description = getCurrentTools(requests.at(-1)!).find(
        (t) => t.name === "codemode",
      )!.description
      expect(description).toContain("### `read`")
      expect(description).not.toContain("### `bash`")
      expect(description).not.toContain("declare const tools")
    },
  )
})

test("budget-only overrides preserve exact native sections and native selection for available declarations", async () => {
  await withSession({ budget: 500 }, "only", async (session, requests) => {
    await session.prompt("budget")
    const storedDescription = getCurrentTools(
      session.sessionManager.buildSessionContext().messages,
    ).find((t) => t.name === "codemode")!.description
    const description = getCurrentTools(requests.at(-1)!).find(
      (t) => t.name === "codemode",
    )!.description
    const tools = session.getAllTools()
    const native = readNativeCatalog(storedDescription, tools)
    const actual = readNativeCatalog(description, tools)
    const sorted = [...native.sections].sort(
      ([, a], [, b]) => Math.ceil(a.length / 4) - Math.ceil(b.length / 4),
    )
    let remaining = 500
    const expected = new Set<string>()
    for (const [name, text] of sorted) {
      const cost = Math.ceil(text.length / 4)
      if (cost > remaining) break
      expected.add(name)
      remaining -= cost
    }
    expect(new Set(actual.sections.keys())).toEqual(expected)
    for (const [name, text] of actual.sections) expect(text).toBe(native.sections.get(name)!)
    expect(actual.prefix).toBe(native.prefix)
  })
})

import { readNativeCatalog } from "../src/catalog"

test("custom catalogs keep native permission gates for nested calls", async () => {
  await withSession(
    { rules: [{ match: ["read"], level: "omit" }] },
    "only",
    async (session, _requests, { pi, script }) => {
      pi.on("tool_call", (event) =>
        event.toolName === "read" ? { block: true, reason: "test permission denied" } : undefined,
      )
      script('await tools.read({path:"sample.txt"});')
      await session.prompt("permission boundary")
      const results = JSON.stringify(
        session.messages.filter((message) => message.role === "toolResult"),
      )
      expect(results).toContain("test permission denied")
      expect(results).toContain("Script failed")
    },
  )
})

test("default Deferred MCP remains discoverable but absent from a globally guaranteed catalog", async () => {
  await withSession(
    { budget: 0, exposeAllActiveTools: true },
    "only",
    async (session, requests, { pi, script }) => {
      pi.registerMcpServer("docs", {
        command: "node",
        args: ["-e", mcpServer],
        exposure: "codemode",
      })
      script(
        'text(await describeTool("mcp__docs__search")); text(ALL_TOOLS.some(t=>t.name==="mcp__docs__search"));',
      )
      await session.prompt("discover")
      expect(JSON.stringify(session.messages)).not.toContain("Script failed")
      const description = getCurrentTools(requests.at(-1)!).find(
        (t) => t.name === "codemode",
      )!.description
      expect(description).not.toContain("mcp__docs__search")
      expect(session.getCallableToolNames()).toContain("mcp__docs__search")
      pi.unregisterMcpServer("docs")
    },
  )
})

for (const mode of ["on", "only"] as const) {
  test(`Direct MCP follows native ${mode} mode even with exposure guarantees`, async () => {
    await withSession(
      {
        budget: 0,
        exposeAllActiveTools: true,
        rules: [{ match: ["mcp__docs__search"], level: "full", forceExpose: true }],
      },
      mode,
      async (session, requests, { pi, script }) => {
        pi.registerMcpServer("docs", {
          command: "node",
          args: ["-e", mcpServer],
          exposure: "direct",
        })
        script('text(await tools.mcp__docs__search({query:"direct call"}));')
        await session.prompt("direct connection")
        expect(JSON.stringify(session.messages)).not.toContain("Script failed")
        const tools = getCurrentTools(requests.at(-1)!)
        const description = tools.find((t) => t.name === "codemode")!.description
        expect(description.includes("### `mcp__docs__search`")).toBe(mode === "only")
        expect(tools.some((t) => t.name === "mcp__docs__search")).toBe(mode === "on")
        expect(session.getAllTools().find((t) => t.name === "mcp__docs__search")!.exposure).toBe(
          "direct",
        )
        pi.unregisterMcpServer("docs")
      },
    )
  })
}

test("untrusted project configuration is not opened, including on reload", async () => {
  await withSession(
    { budget: 0, exposeAllActiveTools: true },
    "only",
    async (session, requests, { root }) => {
      mkdirSync(join(root, "workspace", ".pi"), { recursive: true })
      writeFileSync(
        join(root, "workspace", ".pi", "codemode-tool-catalog.json"),
        "invalid JSON must not be read",
      )
      await session.reload()
      await session.prompt("untrusted")
      const description = getCurrentTools(requests.at(-1)!).find(
        (t) => t.name === "codemode",
      )!.description
      expect(description).toContain("### `read`")
      expect(description).not.toContain("declare const tools")
    },
    false,
  )
})

test("explicit defaults and disabled configuration preserve native descriptions", async () => {
  for (const config of [
    { enabled: true, budget: "inherit", exposeAllActiveTools: false, rules: [] },
    {
      enabled: false,
      budget: 0,
      exposeAllActiveTools: true,
      rules: [{ match: ["read"], level: "omit" }],
    },
  ]) {
    await withSession(config, "only", async (session, requests) => {
      await session.prompt("no changes")
      expect(
        getCurrentTools(requests.at(-1)!).find((t) => t.name === "codemode")!.description,
      ).toBe(
        getCurrentTools(session.sessionManager.buildSessionContext().messages).find(
          (t) => t.name === "codemode",
        )!.description,
      )
    })
  }
})
