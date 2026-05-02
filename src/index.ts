#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.EXALTBYTE_API_URL ?? "https://api.exaltbyte.com/api/v1";
const API_KEY = process.env.EXALTBYTE_API_KEY ?? "";
const ORG_ID = process.env.EXALTBYTE_ORG_ID ?? "";

async function api(method: string, path: string, body?: unknown) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg: string;
    try {
      const err = JSON.parse(text);
      msg = err.message ?? text;
    } catch {
      msg = text;
    }
    throw new Error(`${res.status} ${res.statusText}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function fmtApp(app: Record<string, unknown>) {
  return [
    `Name: ${app.name}`,
    `ID: ${app.id}`,
    `Status: ${app.status}`,
    `Source: ${app.source} (${app.buildType})`,
    app.host ? `URL: https://${app.host}` : null,
    app.dockerImage ? `Image: ${app.dockerImage}` : null,
    app.githubRepo ? `Repo: ${app.githubRepo} (${app.githubBranch ?? "main"})` : null,
    `Instance: ${app.instanceSize}`,
    `Port: ${app.port}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtDb(db: Record<string, unknown>) {
  const pooler = db.pooler as Record<string, unknown> | null;
  return [
    `Name: ${db.name}`,
    `ID: ${db.id}`,
    `Engine: ${db.engine} ${db.version ?? ""}`.trim(),
    `Status: ${db.status}`,
    `Host: ${db.host}:${db.externalPort ?? db.port}`,
    `Database: ${db.dbName}`,
    `Instance: ${db.instanceSize}`,
    pooler ? `Pooler: ${pooler.poolerHost}:${pooler.poolerPort} (${pooler.poolerStatus})` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const server = new McpServer({
  name: "exaltbyte",
  version: "0.1.0",
});

// ── Deploy App ──────────────────────────────────────────────────────────────

server.tool(
  "deploy_app",
  "Deploy an application to ExaltByte. Supports GitHub/GitLab repos or Docker images. For GitHub: provide the repo in 'owner/repo' format. Auto-detects framework and builds with Nixpacks.",
  {
    name: z.string().min(3).describe("App name (lowercase, alphanumeric)"),
    source: z.enum(["github", "gitlab", "docker"]).describe("Source type"),
    githubRepo: z
      .string()
      .optional()
      .describe("GitHub/GitLab repo in 'owner/repo' format"),
    branch: z.string().optional().describe("Git branch (default: main)"),
    dockerImage: z
      .string()
      .optional()
      .describe("Docker image for docker source (e.g. nginx:latest)"),
    buildType: z
      .enum(["nixpacks", "dockerfile", "image"])
      .optional()
      .describe("Build type (default: nixpacks for git, image for docker)"),
    port: z.number().optional().describe("App port (default: 3000)"),
    envVars: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables as key-value pairs"),
    instanceSize: z
      .enum(["micro", "small", "medium", "large", "xlarge"])
      .optional()
      .describe("Instance size (default: small)"),
  },
  async ({ name, source, githubRepo, branch, dockerImage, buildType, port, envVars, instanceSize }) => {
    try {
      const body: Record<string, unknown> = {
        name,
        source,
        buildType: buildType ?? (source === "docker" ? "image" : "nixpacks"),
      };
      if (githubRepo) body.githubRepo = githubRepo;
      if (branch) body.githubBranch = branch;
      if (dockerImage) body.dockerImage = dockerImage;
      if (port) body.port = port;
      if (envVars) body.envVars = envVars;
      if (instanceSize) body.instanceSize = instanceSize;

      const app = await api("POST", `/orgs/${ORG_ID}/apps`, body);
      return ok(
        `App deployed successfully!\n\n${fmtApp(app)}\n\nThe app is now provisioning. Use get_app_status to check progress.`
      );
    } catch (e) {
      return err(`Deploy failed: ${(e as Error).message}`);
    }
  }
);

// ── Create Database ─────────────────────────────────────────────────────────

server.tool(
  "create_database",
  "Create a new managed database (PostgreSQL, MySQL, Redis, or MongoDB). Returns connection details once provisioned.",
  {
    name: z.string().min(3).describe("Database name"),
    engine: z
      .enum(["postgres", "mysql", "redis", "mongodb"])
      .describe("Database engine"),
    version: z.string().optional().describe("Engine version (e.g. '16' for postgres)"),
    instanceSize: z
      .enum(["micro", "small", "medium", "large", "xlarge"])
      .optional()
      .describe("Instance size (default: small)"),
  },
  async ({ name, engine, version, instanceSize }) => {
    try {
      const body: Record<string, unknown> = { name, engine };
      if (version) body.version = version;
      if (instanceSize) body.instanceSize = instanceSize;

      const db = await api("POST", `/orgs/${ORG_ID}/databases`, body);
      return ok(
        `Database created!\n\n${fmtDb(db)}\n\nProvisioning in progress. Use get_database_info to check status and get connection string.`
      );
    } catch (e) {
      return err(`Create database failed: ${(e as Error).message}`);
    }
  }
);

// ── List Apps ───────────────────────────────────────────────────────────────

server.tool(
  "list_apps",
  "List all deployed applications in the organization.",
  {},
  async () => {
    try {
      const apps: Record<string, unknown>[] = await api("GET", `/orgs/${ORG_ID}/apps`);
      if (!apps.length) return ok("No apps deployed yet.");
      const lines = apps.map(
        (a) => `• ${a.name} [${a.status}] — ${a.instanceSize} — ${a.host ? `https://${a.host}` : "no host yet"}`
      );
      return ok(`${apps.length} app(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Databases ──────────────────────────────────────────────────────────

server.tool(
  "list_databases",
  "List all databases in the organization.",
  {},
  async () => {
    try {
      const dbs: Record<string, unknown>[] = await api("GET", `/orgs/${ORG_ID}/databases`);
      if (!dbs.length) return ok("No databases yet.");
      const lines = dbs.map(
        (d) => `• ${d.name} [${d.engine}] — ${d.status} — ${d.instanceSize}`
      );
      return ok(`${dbs.length} database(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get App Status ──────────────────────────────────────────────────────────

server.tool(
  "get_app_status",
  "Get detailed status of a deployed application including URL, build info, and live status.",
  {
    appId: z.string().describe("The app ID"),
  },
  async ({ appId }) => {
    try {
      const app = await api("GET", `/orgs/${ORG_ID}/apps/${appId}`);
      return ok(fmtApp(app));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get Database Info ───────────────────────────────────────────────────────

server.tool(
  "get_database_info",
  "Get database details and connection string. Returns both direct and pooler (PgBouncer) connection strings for PostgreSQL.",
  {
    databaseId: z.string().describe("The database ID"),
  },
  async ({ databaseId }) => {
    try {
      const [db, conn] = await Promise.all([
        api("GET", `/orgs/${ORG_ID}/databases/${databaseId}`),
        api("GET", `/orgs/${ORG_ID}/databases/${databaseId}/connection-string`).catch(() => null),
      ]);
      let text = fmtDb(db);
      if (conn) {
        text += `\n\nConnection String: ${conn.connectionString}`;
        if (conn.poolerConnectionString) {
          text += `\nPooler (recommended): ${conn.poolerConnectionString}`;
        }
      }
      return ok(text);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Update Env Vars ─────────────────────────────────────────────────────────

server.tool(
  "update_env_vars",
  "Update environment variables for an application. Merges with existing env vars and triggers a redeploy.",
  {
    appId: z.string().describe("The app ID"),
    envVars: z.record(z.string(), z.string()).describe("Environment variables to set (key-value pairs)"),
  },
  async ({ appId, envVars }) => {
    try {
      await api("PATCH", `/orgs/${ORG_ID}/apps/${appId}/env`, { envVars });
      const keys = Object.keys(envVars);
      return ok(`Updated ${keys.length} env var(s): ${keys.join(", ")}\nApp will redeploy automatically.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Manage App (start/stop/restart/redeploy) ────────────────────────────────

server.tool(
  "manage_app",
  "Start, stop, restart, or redeploy an application.",
  {
    appId: z.string().describe("The app ID"),
    action: z.enum(["start", "stop", "restart", "redeploy"]).describe("Action to perform"),
  },
  async ({ appId, action }) => {
    try {
      await api("POST", `/orgs/${ORG_ID}/apps/${appId}/${action}`);
      return ok(`App ${action} initiated successfully.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Manage Database (start/stop/restart) ────────────────────────────────────

server.tool(
  "manage_database",
  "Start, stop, or restart a database.",
  {
    databaseId: z.string().describe("The database ID"),
    action: z.enum(["start", "stop", "restart"]).describe("Action to perform"),
  },
  async ({ databaseId, action }) => {
    try {
      await api("PATCH", `/orgs/${ORG_ID}/databases/${databaseId}/${action}`);
      return ok(`Database ${action} initiated successfully.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Delete App ──────────────────────────────────────────────────────────────

server.tool(
  "delete_app",
  "Delete an application. This is irreversible — the app and all its data will be permanently removed.",
  {
    appId: z.string().describe("The app ID to delete"),
  },
  async ({ appId }) => {
    try {
      await api("DELETE", `/orgs/${ORG_ID}/apps/${appId}`);
      return ok("App deleted successfully.");
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Delete Database ─────────────────────────────────────────────────────────

server.tool(
  "delete_database",
  "Delete a database. This is irreversible — the database and all its data will be permanently removed.",
  {
    databaseId: z.string().describe("The database ID to delete"),
  },
  async ({ databaseId }) => {
    try {
      await api("DELETE", `/orgs/${ORG_ID}/databases/${databaseId}`);
      return ok("Database deleted successfully.");
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get App Logs ────────────────────────────────────────────────────────────

server.tool(
  "get_app_logs",
  "Get recent logs for an application. Returns the last N lines of container output.",
  {
    appId: z.string().describe("The app ID"),
    tail: z.number().optional().describe("Number of recent lines to fetch (default: 100)"),
  },
  async ({ appId, tail }) => {
    try {
      const t = tail ?? 100;
      const res = await fetch(
        `${API_BASE}/orgs/${ORG_ID}/apps/${appId}/logs/live?tail=${t}`,
        {
          headers: { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" },
          signal: AbortSignal.timeout(5000),
        }
      );
      const text = await res.text();
      const lines = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => {
          try {
            return JSON.parse(l.slice(5));
          } catch {
            return l.slice(5).trim();
          }
        })
        .filter(Boolean);
      return ok(lines.length ? lines.join("\n") : "No logs available.");
    } catch (e) {
      return err(`Failed to fetch logs: ${(e as Error).message}`);
    }
  }
);

// ── Get Database Logs ───────────────────────────────────────────────────────

server.tool(
  "get_database_logs",
  "Get recent logs for a database container.",
  {
    databaseId: z.string().describe("The database ID"),
    tail: z.number().optional().describe("Number of recent lines (default: 100)"),
  },
  async ({ databaseId, tail }) => {
    try {
      const t = tail ?? 100;
      const res = await fetch(
        `${API_BASE}/orgs/${ORG_ID}/databases/${databaseId}/logs/live?tail=${t}`,
        {
          headers: { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" },
          signal: AbortSignal.timeout(5000),
        }
      );
      const text = await res.text();
      const lines = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => {
          try {
            return JSON.parse(l.slice(5));
          } catch {
            return l.slice(5).trim();
          }
        })
        .filter(Boolean);
      return ok(lines.length ? lines.join("\n") : "No logs available.");
    } catch (e) {
      return err(`Failed to fetch logs: ${(e as Error).message}`);
    }
  }
);

// ── Supported Versions ──────────────────────────────────────────────────────

server.tool(
  "list_database_versions",
  "List supported database engines and their available versions.",
  {},
  async () => {
    try {
      const versions: { engine: string; versions: string[]; default: string }[] = await api(
        "GET",
        "/databases/versions"
      );
      const lines = versions.map(
        (v) => `${v.engine}: ${v.versions.join(", ")} (default: ${v.default})`
      );
      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Start Server ────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error("EXALTBYTE_API_KEY is required. Set it in your MCP server config.");
    process.exit(1);
  }
  if (!ORG_ID) {
    console.error("EXALTBYTE_ORG_ID is required. Set it in your MCP server config.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
