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
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "catalog-integration-"))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const requests: Message[][] = []
  const settings = SettingsManager.inMemory({
    codemode: { mode, inlineBudget: 10000 },
    defaultTools: ["read", "bash", "edit", "write", "codemode"],
    compaction: { enabled: false },
    retry: { enabled: false },
  })
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
      (pi) => {
        pi.registerProvider("catalog-test", {
          baseUrl: "http://unused.invalid",
          api: "catalog-test-api",
          apiKey: "test-only",
          streamSimple: (model, context) => {
            requests.push(structuredClone(context.messages))
            const stream = createAssistantMessageEventStream()
            const message: AssistantMessage = {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: "stop",
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
            stream.push({ type: "done", reason: "stop", message })
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
    await run(session, requests)
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
