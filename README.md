# ExaltByte MCP Server

Deploy apps, manage databases, and operate your entire cloud infrastructure from AI assistants like Claude Code — no dashboard required.

## What is this?

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude Code, Claude Desktop, and other MCP-compatible AI assistants directly to the [ExaltByte](https://exaltbyte.com) platform API. You describe what you want in natural language, and the AI handles the rest.

```
You: "Deploy my Next.js app from github bimapanduw/my-app with a Postgres database"

Claude: → deploys the app via deploy_app
        → creates a PostgreSQL database via create_database
        → sets DATABASE_URL on the app via update_env_vars
        → returns the live URL
```

## Quick Start

### 1. Get your API key

Go to **Settings > API Keys** in the [ExaltByte Dashboard](https://app.exaltbyte.com) and create a new key. Copy the key and your Organization ID.

### 2. Add to Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "exaltbyte": {
      "command": "npx",
      "args": ["-y", "@exaltbyte/mcp-server"],
      "env": {
        "EXALTBYTE_API_KEY": "dbaas_your_api_key_here",
        "EXALTBYTE_ORG_ID": "your-org-id"
      }
    }
  }
}
```

### 3. Start using it

```
claude "deploy my app from github owner/repo"
claude "create a postgres 16 database called mydb"
claude "what's my current billing usage?"
```

## Setup for other clients

<details>
<summary>Claude Desktop</summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "exaltbyte": {
      "command": "npx",
      "args": ["-y", "@exaltbyte/mcp-server"],
      "env": {
        "EXALTBYTE_API_KEY": "dbaas_your_api_key_here",
        "EXALTBYTE_ORG_ID": "your-org-id"
      }
    }
  }
}
```

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

</details>

<details>
<summary>VS Code (Claude Code Extension)</summary>

Add to `.vscode/settings.json` in your project:

```json
{
  "claude-code.mcpServers": {
    "exaltbyte": {
      "command": "npx",
      "args": ["-y", "@exaltbyte/mcp-server"],
      "env": {
        "EXALTBYTE_API_KEY": "dbaas_your_api_key_here",
        "EXALTBYTE_ORG_ID": "your-org-id"
      }
    }
  }
}
```

</details>

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXALTBYTE_API_KEY` | Yes | Your API key (starts with `dbaas_`) |
| `EXALTBYTE_ORG_ID` | Yes | Your organization ID |
| `EXALTBYTE_API_URL` | No | API base URL (default: `https://api.exaltbyte.com/api/v1`) |

## Available Tools (41)

### Apps

| Tool | Description |
|------|-------------|
| `deploy_app` | Deploy from GitHub/GitLab repo or Docker image. Auto-detects framework with Nixpacks. |
| `list_apps` | List all deployed applications. |
| `get_app_status` | Get app details: URL, build info, status. |
| `manage_app` | Start, stop, restart, or redeploy an app. |
| `delete_app` | Permanently delete an app. |
| `update_env_vars` | Set environment variables (triggers redeploy). |
| `get_app_env_vars` | Read current environment variables. |
| `update_app_settings` | Change branch, build path, port, or Docker image. |
| `add_app_domain` | Attach a custom domain. |
| `get_app_logs` | Get recent container logs. |
| `get_deployment_logs` | Get build/deploy logs for a specific deployment. |

### App Scaling

| Tool | Description |
|------|-------------|
| `scale_app` | Add/remove nodes or resize a node for horizontal/vertical scaling. |
| `list_app_nodes` | List all nodes for a horizontally-scaled app. |

### Databases

| Tool | Description |
|------|-------------|
| `create_database` | Create PostgreSQL, MySQL, Redis, or MongoDB. |
| `list_databases` | List all databases. |
| `get_database_info` | Get details + connection string (includes PgBouncer pooler for Postgres). |
| `manage_database` | Start, stop, or restart a database. |
| `resize_database` | Change instance size (restarts the database). |
| `delete_database` | Permanently delete a database. |
| `get_database_logs` | Get recent container logs. |
| `get_database_health` | CPU, memory, disk, connections, cache hit ratio. |
| `list_database_versions` | List supported engines and versions. |

### Backups

| Tool | Description |
|------|-------------|
| `list_backups` | List all backups for a database. |
| `trigger_backup` | Create a manual backup. |
| `restore_backup` | Restore from a specific backup. |
| `toggle_backup` | Enable/disable automated daily backups. |

### Replicas

| Tool | Description |
|------|-------------|
| `list_replicas` | List read replicas (PostgreSQL/MySQL). |
| `create_replica` | Create a new read replica. |
| `delete_replica` | Delete a read replica. |

### Services

| Tool | Description |
|------|-------------|
| `deploy_service` | Deploy a Docker image as a managed service. |
| `list_services` | List all services. |
| `get_service_info` | Get service details. |
| `manage_service` | Start, stop, restart, or redeploy a service. |
| `delete_service` | Permanently delete a service. |
| `update_service_env_vars` | Set environment variables (triggers redeploy). |
| `add_service_domain` | Attach a custom domain. |
| `get_service_logs` | Get recent container logs. |
| `list_service_images` | Browse available pre-configured images (Redis, Memcached, etc). |

### Billing & Pricing

| Tool | Description |
|------|-------------|
| `get_usage` | Balance, burn rate, estimated days left, per-resource cost breakdown. |
| `list_instance_sizes` | Available sizes with CPU, memory, and pricing. |

### Discovery

| Tool | Description |
|------|-------------|
| `list_git_repos` | Browse GitHub/GitLab repos connected to the org. |

## Example Prompts

**Deploy a full-stack app:**
> "Deploy my Next.js app from github myuser/my-app on the main branch, create a postgres 16 database called myapp-db, and set the DATABASE_URL env var on the app"

**Check costs:**
> "What's my current usage and how many days of balance do I have left?"

**Scale up:**
> "Resize my production database to large and add another node to my web app"

**Manage backups:**
> "Enable daily backups on my postgres database and trigger one now"

**Debug issues:**
> "Show me the logs for my api-server app and check the database health"

**Deploy a Redis cache:**
> "Deploy a Redis 7 service called my-cache on a micro instance"

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run production build
npm start
```

## How it works

The MCP server runs as a local stdio process. When an MCP-compatible AI assistant (like Claude) needs to interact with ExaltByte, it calls the appropriate tool with structured parameters. The server translates these into ExaltByte API calls and returns formatted results.

```
User prompt → Claude → MCP tool call → ExaltByte API → Response → Claude → User
```

All communication happens over stdin/stdout using the [Model Context Protocol](https://modelcontextprotocol.io). No HTTP server is needed.

## License

MIT
