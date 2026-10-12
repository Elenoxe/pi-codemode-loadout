import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  createCodemodeExtension,
  getAgentDir,
  type ExtensionAPI,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent"
import { isNativeConfig, loadConfig, type CatalogConfig } from "./config"
import { createCatalog } from "./catalog"

/** Replay declaration deltas; replace only the declaration that is currently effective. */
export function updateCodemodeDescription(
  messages: AgentMessage[],
  render: (description: string) => string,
): AgentMessage[] {
  let current = -1
  for (const [index, message] of messages.entries()) {
    if (message.role !== "system") continue
    if (message.toolsRemoved?.some((tool) => tool.name === "codemode")) current = -1
    if (message.toolsAdded?.some((tool) => tool.name === "codemode")) current = index
  }
  const message = messages[current]
  if (!message || message.role !== "system") return messages
  const toolsAdded = message.toolsAdded?.map((tool) =>
    tool.name === "codemode" ? { ...tool, description: render(tool.description) } : tool,
  )
  return messages.map((item, index) => (index === current ? { ...message, toolsAdded } : item))
}

export default function codemodeToolCatalog(pi: ExtensionAPI): void {
  let config: CatalogConfig | undefined
  let loadout: ToolLoadout | undefined
  let captured = false
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
    // Let Pi resolve trust, settings and CLI selection before taking over an existing tool.
    const native = pi.getAllTools().find((tool) => tool.name === "codemode")
    if (native?.sourceInfo.path !== "builtin:codemode") return
    createCodemodeExtension()({
      ...pi,
      registerTool(tool) {
        const prepareLoadout = tool.prepareLoadout
        if (tool.name !== "codemode" || !prepareLoadout)
          throw new Error("Unsupported native Codemode definition: prepareLoadout is required.")
        pi.registerTool({
          ...tool,
          prepareLoadout(current) {
            loadout = current
            return prepareLoadout(current)
          },
        })
      },
    })
    if (
      pi.getAllTools().find((tool) => tool.name === "codemode")?.sourceInfo.path ===
      "builtin:codemode"
    )
      throw new Error(
        "Load the catalog as an extension path before builtin:codemode, not as a later inline factory.",
      )
    captured = true
  })
  pi.on("context_with_system", (event, ctx) => {
    if (!captured || !pi.getActiveTools().includes("codemode")) return
    config ??= loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
    if (isNativeConfig(config)) return
    const current = loadout
    if (!current) throw new Error("Native Codemode loadout is unavailable.")
    const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]))
    const tools = current.callable.map((tool) => {
      const info = metadata.get(tool.name)
      if (!info) throw new Error(`Missing native metadata for callable tool: ${tool.name}`)
      return { ...info, outputSchema: tool.outputSchema }
    })
    const settings = pi.getSettings().codemode
    const budget = settings?.inlineBudget
    return {
      messages: updateCodemodeDescription(event.messages, (description) =>
        createCatalog(description, config!, {
          tools,
          active: new Set(current.declared.map((tool) => tool.name)),
          mode: settings?.mode === "only" ? "only" : "on",
          inlineBudget:
            typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 3000,
        }),
      ),
    }
  })
}
