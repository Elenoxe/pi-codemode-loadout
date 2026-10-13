import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { AgentSession, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isNativeConfig, loadConfig, type CatalogConfig } from "./config"
import { createCatalog, type CatalogToolInfo } from "./catalog"

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

/** Read live schemas synchronously without taking ownership of native tools. */
export function getToolsWithSchemas(pi: ExtensionAPI): CatalogToolInfo[] {
  const original = AgentSession.prototype.getAllTools
  AgentSession.prototype.getAllTools = function () {
    return original.call(this).map((tool) => ({
      ...tool,
      outputSchema: this.getToolDefinition(tool.name)?.outputSchema,
    }))
  }
  try {
    return pi.getAllTools()
  } finally {
    AgentSession.prototype.getAllTools = original
  }
}

export default function codemodeToolCatalog(pi: ExtensionAPI): void {
  let config: CatalogConfig | undefined
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
  })
  pi.on("context_with_system", (event, ctx) => {
    const active = new Set(pi.getActiveTools())
    if (!active.has("codemode")) return
    config ??= loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
    if (isNativeConfig(config)) return
    const tools = getToolsWithSchemas(pi)
    const settings = pi.getSettings().codemode
    const budget = settings?.inlineBudget
    return {
      messages: updateCodemodeDescription(event.messages, (description) =>
        createCatalog(description, config!, {
          tools,
          active,
          mode: settings?.mode === "only" ? "only" : "on",
          inlineBudget:
            typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 3000,
        }),
      ),
    }
  })
}
