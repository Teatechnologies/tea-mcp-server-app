# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, define each tool inside the `init()` method of `src/index.ts` using `this.server.tool(...)`.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/mcp`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp" // or remote-mcp-server-authless.your-account.workers.dev/mcp
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.

## Capacity Board tools (TruckVerifi)

`capacity_boards`, `capacity_board_cards`, `capacity_board_add_carrier` and `capacity_board_move_card` act as a
specific TruckVerifi user, so the MCP connection must carry that user's own TEA API key (created at
https://www.theteaintel.com/api) as `Authorization: Bearer <key>` or `x-api-key`. The fetch handler passes it to the
tools as `this.props.userApiKey`; the gateway (`tea-mcp-rpc`) resolves the key's owner and runs the board RPCs as
them. Without a key those four tools explain how to connect; every other tool keeps using the Worker's `TEA_API_KEY`.

With mcp-remote:

```bash
npx mcp-remote https://tea-mcp-server-app.robertcr8.workers.dev/mcp --header "Authorization: Bearer <key>"
```

### Signing in from claude.ai (OAuth)

The same tools are also served at `/sso/mcp` behind OAuth with dynamic client registration, so claude.ai and
other MCP clients can add `https://tea-mcp-server-app.robertcr8.workers.dev/sso/mcp` as a connector with no
header. The sign-in page (`/authorize`, `src/sso.ts`) sends a Supabase email one-time code to the user's TEA /
TruckVerifi account; on success the grant carries their user id, API plan and a self-serve key named "Claude MCP"
(created once through `my_api_key_create`, remembered in the `OAUTH_KV` namespace), which the Capacity Board tools
use. Accounts without an API plan can still sign in; the board tools then explain what to enable at theteaintel.com/api.
