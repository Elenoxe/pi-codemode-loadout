import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
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
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
  })
  pi.on("context_with_system", (event, ctx) => {
    config ??= loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())
    if (isNativeConfig(config)) return
    const settings = pi.getSettings().codemode
    const budget = settings?.inlineBudget
    return {
      messages: updateCodemodeDescription(event.messages, (description) =>
        createCatalog(description, config!, {
          tools: pi.getAllTools(),
          active: new Set(pi.getActiveTools()),
          mode: settings?.mode === "only" ? "only" : "on",
          inlineBudget:
            typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 3000,
        }),
      ),
    }
  })
}
