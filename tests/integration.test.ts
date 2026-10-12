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
