# pi-codemode-tool-catalog

Configurable tool catalog exposure and prioritization for Pi Codemode.

Pi's [`codemode`](https://pi.dev/docs/latest/codemode) tool lists tools in its description so the model knows what scripts can call. Natively, a token budget decides which tools enter this inline catalog, and each tool is all-or-nothing: it is either written into the description with its full description and TypeScript declaration, or left out, in which case the model has to find it through `searchTools()` and `describeTool()`.

This extension adds three levels of detail to that allocation:

- `full`: the complete description and TypeScript declaration, as in native Pi.
- `hint`: the tool's name plus a short piece of usage text, without the declaration.
- `name`: only the tool's name, in a compact list.

On top of these levels, you can customize how each tool is presented and set the priority between tools. This lets you keep important tools visible while spending fewer tokens on tools that do not need a full declaration.

> **Note:** Pi defaults to `codemode.mode: "on"`. In this mode, tools declared directly to the model are not included in the codemode catalog, and this extension's rules do not apply to them. To have Pi call tools only through codemode, set `"only"` in `~/.pi/agent/settings.json`:
>
> ```json
> {
>   "defaultTools": ["+codemode"],
>   "codemode": {
>     "mode": "only"
>   }
> }
> ```

## Example: more tools, same budget

Suppose Pi runs in `only` mode with seven active built-in tools, but the inline budget only fits two complete declarations.

Without the extension, the catalog might look like this:

````text
### `bash`
Execute shell commands.

codemode tool declaration:
```ts
declare const tools: {
  bash(args: { command: string }): Promise<string>;
};
```

### `ls`
List files and directories.

codemode tool declaration:
```ts
declare const tools: {
  ls(args: { path?: string }): Promise<string>;
};
```
````

With this extension, the same budget could produce:

````text
### `bash`
Execute shell commands.

codemode tool declaration:
```ts
declare const tools: {
  bash(args: { command: string }): Promise<string>;
};
```

### `ls`
List files and directories.

Other available tools (inspect with `describeTool(name)`):
`read`, `write`, `edit`, `grep`, `find`
````

Both catalogs give `bash` a full declaration. Instead of spending the remaining budget on a second declaration, the extension gives `ls` a `hint` and lists the five remaining built-in tools by `name`.

This matters because the model can only choose from tools it knows about. In the native catalog, `read`, `write` and `edit` are not listed upfront, so the model may use `bash` for file operations instead of discovering the dedicated tools.

With the extension, those tools are visible from the start. The model can see that a more suitable tool exists, fetch its schema with `describeTool(name)`, and use it.

## Installation

```bash
pi install npm:@eleno/pi-codemode-tool-catalog
```

Or install from GitHub:

```bash
pi install git:github.com/Elenoxe/pi-codemode-tool-catalog
```

## Quick start

Create a catalog config at `~/.pi/agent/codemode-tool-catalog.json`, or a project config at `<project>/.pi/codemode-tool-catalog.json`.

```json
{
  "budget": 3000,
  "rules": [
    {
      "match": ["read", "write", "edit"],
      "priority": 100,
      "minLevel": "hint"
    },
    {
      "match": ["ls", "find", "grep"],
      "priority": 90
    },
    {
      "match": ["bash"],
      "maxLevel": "hint",
      "hint": "Run shell commands"
    }
  ]
}
```

What this does:

1. `budget: 3000` sets the token budget for catalog entries.
2. `read`, `write` and `edit` always appear at least as a `hint`. Their priority is 100, so they are upgraded to `full` before lower-priority tools, as far as the remaining budget allows.
3. `ls`, `find` and `grep` have priority 90, so they are upgraded after the priority-100 tools, as budget allows.
4. `bash` never goes beyond `hint`, and its hint text is `Run shell commands`.

Start a new session or run `/reload` to apply changes.

## Configuration

### Top-level options

| Field                  | Type                        | Default     | Description                                                                                         |
| ---------------------- | --------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `enabled`              | `boolean`                   | `true`      | Enables or disables this extension. `false` restores Pi's native description.                       |
| `budget`               | `number ≥ 0` \| `"inherit"` | `"inherit"` | Token budget for catalog entries. `"inherit"` uses Pi's `codemode.inlineBudget` (3000 if unset).    |
| `exposeAllActiveTools` | `boolean`                   | `false`     | Guarantees every eligible active tool at least a `name` entry. These entries can exceed the budget. |
| `rules`                | `Rule[]`                    | `[]`        | Tool-specific allocation rules.                                                                     |

Project values override user values per top-level field. The `rules` array is replaced, not merged.

### Rules

Each rule selects tools and sets how they appear in the catalog.

| Field      | Type                                         | Default  | Description                                                          |
| ---------- | -------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `match`    | `(string \| Selector)[]`                     | Required | Tool names or selectors to match.                                    |
| `priority` | `number`                                     | `0`      | Allocation priority. Higher values are processed first.              |
| `minLevel` | `"name"` \| `"hint"` \| `"full"`             | Unset    | Minimum guaranteed level.                                            |
| `maxLevel` | `"name"` \| `"hint"` \| `"full"` \| `"omit"` | `"full"` | Maximum permitted level. `"omit"` removes the tool from the catalog. |
| `hint`     | `string`                                     | Unset    | Custom hint text. Replaces the tool's native `promptSnippet`.        |

#### Matching tools

`match` accepts exact tool names or structured selectors:

| Field       | Type               | Description                                                                                                                               |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | `string`           | Exact tool name, such as `read` or `mcp__docs__search`.                                                                                   |
| `namespace` | `string` \| `null` | Exact namespace. `null` matches tools without a namespace.                                                                                |
| `source`    | `string`           | Origin of the tool: `builtin` for Pi's built-in tools, or a package identifier such as `npm:package-name` or `git:github.com/owner/repo`. |

MCP tool names follow the `mcp__<server>__<tool>` convention. For example, `mcp__docs__search` is the `search` tool from the `docs` server.

Use `name` to match one MCP tool, or `namespace` to match every tool from a server:

```json
{
  "match": ["mcp__docs__search", { "namespace": "mcp__github" }]
}
```

Fields within one selector are combined with AND. Entries in the `match` list are combined with OR.

When multiple rules match a tool, the first matching rule takes precedence.

#### Display bounds

The levels are ordered `name` < `hint` < `full`.

`minLevel` guarantees a minimum representation. These guarantees are reserved before ordinary allocation, even if they exceed the budget.

For example, this guarantees that `read` appears at least as a `hint`, and allows `full` if the budget permits:

```json
{
  "match": ["read"],
  "minLevel": "hint",
  "maxLevel": "full"
}
```

To leave a tool out of the catalog:

```json
{
  "match": ["some_tool"],
  "maxLevel": "omit"
}
```

`omit` only removes the tool from the catalog. The tool stays registered, and Codemode can still discover and call it.

#### Custom hints

At the `hint` level, the tool's native `promptSnippet` is used by default. To replace it with your own text:

```json
{
  "match": ["grep"],
  "maxLevel": "hint",
  "hint": "Search file contents for matching patterns."
}
```

If a tool has neither a custom hint nor a usable `promptSnippet`, the `hint` level is unavailable.

## MCP tools

Pi supports several [MCP exposure modes](https://pi.dev/docs/latest/mcp), which determine how MCP tools reach the model:

| Exposure             | Native behavior                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `codemode` (default) | Not declared directly to the model. Enables Codemode, where scripts can discover and call the tools.                      |
| `deferred`           | Not declared directly to the model. Enables `tool_search`, which lets the model discover and load tools for direct calls. |
| `direct`             | Declared directly to the model when active, and also callable from Codemode.                                              |
| `hidden`             | Not available for discovery or execution.                                                                                 |

`direct` MCP tools take part in allocation like any other tool. `codemode` and `deferred` MCP tools are not listed by default; to expose one of them, select it with `minLevel`:

```json
{
  "match": ["mcp__docs__search"],
  "minLevel": "name"
}
```

To select an entire MCP namespace:

```json
{
  "match": [{ "namespace": "mcp__docs" }],
  "minLevel": "name"
}
```

This extension never lists `hidden` tools, even if a rule sets `minLevel`.

## Allocation algorithm

### 1. Reserve minimum levels

Every eligible tool with a `minLevel` first receives that guaranteed level.

If `exposeAllActiveTools` is enabled, eligible active tools without a higher minimum are also guaranteed at least `name`.

These reservations happen before priority-based allocation and may exceed the budget.

### 2. Allocate by priority

The remaining budget is spent from the highest priority to the lowest. Each priority tier goes through these stages before the next tier starts:

| Stage  | Action                                        |
| ------ | --------------------------------------------- |
| `name` | Add tools that are not yet listed.            |
| `hint` | Upgrade eligible tools from `name` to `hint`. |
| `full` | Upgrade eligible tools from `hint` to `full`. |

Each stage respects `maxLevel`. Within a stage, namespaces take turns (round-robin), and each namespace tries its cheapest remaining upgrade first.

## License

MIT
