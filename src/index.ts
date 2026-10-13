import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  AgentSession,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Value } from "typebox/value"
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
    return original.call(this).map((tool) => {
      const definition = this.getToolDefinition(tool.name)
      return {
        ...tool,
        outputSchema: definition?.outputSchema,
        promptSnippet: definition?.promptSnippet,
      }
    })
  }
  try {
    return pi.getAllTools()
  } finally {
    AgentSession.prototype.getAllTools = original
  }
}

function reportDiagnostic(
  message: string,
  severity: "error" | "warning",
  ctx: ExtensionContext,
): void {
  if (ctx.hasUI) ctx.ui.notify(message, severity)
  else if (severity === "warning") console.warn(message)
  else console.error(message)
}

type ConfigState =
  { status: "unloaded" } | { status: "ready"; config: CatalogConfig } | { status: "invalid" }

export default function codemodeToolCatalog(pi: ExtensionAPI): void {
  let configState: ConfigState = { status: "unloaded" }
  const reportedHintErrors = new Set<string>()
  const load = (ctx: ExtensionContext) => {
    configState = { status: "invalid" }
    const config = loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted(), (message, severity) =>
      reportDiagnostic(message, severity, ctx),
    )
    configState = { status: "ready", config }
  }
  pi.on("session_start", (_event, ctx) => {
    reportedHintErrors.clear()
    load(ctx)
  })
  pi.on("context_with_system", (event, ctx) => {
    const active = new Set(pi.getActiveTools())
    if (!active.has("codemode")) return
    if (configState.status === "unloaded") load(ctx)
    if (configState.status !== "ready") return
    const config = configState.config
    if (isNativeConfig(config)) return
    const tools = getToolsWithSchemas(pi)
    const settings = pi.getSettings().codemode
    const budget = settings?.inlineBudget
    return {
      messages: updateCodemodeDescription(event.messages, (description) =>
        createCatalog(description, config, {
          tools,
          active,
          mode: settings?.mode === "only" ? "only" : "on",
          inlineBudget: Value.Check(Type.Number({ minimum: 0 }), budget) ? budget : 3000,
          reportDiagnostic: (message, severity) => {
            if (reportedHintErrors.has(message)) return
            reportedHintErrors.add(message)
            reportDiagnostic(message, severity, ctx)
          },
        }),
      ),
    }
  })
}
