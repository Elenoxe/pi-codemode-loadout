import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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
  pi.on("context_with_system", () => undefined)
}
