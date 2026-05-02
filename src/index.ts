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

type R = Record<string, unknown>;

function fmtApp(app: R) {
  return [
    `Name: ${app.name}`,
    `ID: ${app.id}`,
    `Status: ${app.status}`,
    `Source: ${app.source} (${app.buildType})`,
    app.host ? `URL: https://${app.host}` : null,
    app.customDomain ? `Custom Domain: ${app.customDomain}` : null,
    app.dockerImage ? `Image: ${app.dockerImage}` : null,
    app.githubRepo ? `Repo: ${app.githubRepo} (${app.githubBranch ?? "main"})` : null,
    `Instance: ${app.instanceSize}`,
    `Port: ${app.port}`,
    `Replicas: ${app.replicas ?? 1}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtService(svc: R) {
  return [
    `Name: ${svc.name}`,
    `ID: ${svc.id}`,
    `Status: ${svc.status}`,
    `Image: ${svc.dockerImage}`,
    svc.host ? `URL: https://${svc.host}` : null,
    svc.customDomain ? `Custom Domain: ${svc.customDomain}` : null,
    `Instance: ${svc.instanceSize}`,
    `Port: ${svc.port}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtBackup(b: R) {
  return [
    `ID: ${b.id}`,
    `Status: ${b.status}`,
    b.sizeBytes ? `Size: ${(Number(b.sizeBytes) / 1024 / 1024).toFixed(1)} MB` : null,
    `Created: ${b.createdAt}`,
    b.completedAt ? `Completed: ${b.completedAt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function fmtDb(db: R) {
  const pooler = db.pooler as R | null;
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
      const apps: R[] = await api("GET", `/orgs/${ORG_ID}/apps`);
      if (!apps.length) return ok("No apps deployed yet.");
      const lines = apps.map(
        (a) => `• ${a.name} (${a.id}) [${a.status}] — ${a.instanceSize} — ${a.host ? `https://${a.host}` : "no host yet"}`
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
      const dbs: R[] = await api("GET", `/orgs/${ORG_ID}/databases`);
      if (!dbs.length) return ok("No databases yet.");
      const lines = dbs.map(
        (d) => `• ${d.name} (${d.id}) [${d.engine}] — ${d.status} — ${d.instanceSize}`
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

// ── Get Usage & Balance ────────────────────────────────────────────────────

server.tool(
  "get_usage",
  "Get current billing usage: balance, hourly burn rate, estimated days left, and per-resource cost breakdown.",
  {},
  async () => {
    try {
      const u: R = await api("GET", `/orgs/${ORG_ID}/billing/usage`);
      const items = (u.lineItems as R[]) ?? [];
      const lines = items.map(
        (i) => `  • ${i.name} (${i.type}) — ${i.instanceSize} — Rp ${i.hourlyCost}/hr`
      );
      return ok(
        [
          `Balance: Rp ${Number(u.balance).toLocaleString()}`,
          `Hourly burn: Rp ${u.hourlyBurnRateIDR}/hr`,
          `Spent this month: Rp ${Number(u.spentThisMonthIDR).toLocaleString()}`,
          `Est. monthly cost: Rp ${Number(u.estimatedMonthlyCostIDR).toLocaleString()}`,
          u.estimatedDaysLeft != null ? `Est. days left: ${u.estimatedDaysLeft}` : null,
          `Running: ${u.runningDatabases} DB, ${u.runningApps} app, ${u.runningServices} service`,
          items.length ? `\nLine items:\n${lines.join("\n")}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Instance Sizes ────────────────────────────────────────────────────

server.tool(
  "list_instance_sizes",
  "List available instance sizes with CPU, memory, and pricing info.",
  {},
  async () => {
    try {
      const sizes: R[] = await api("GET", "/billing/instance-sizes");
      const lines = sizes
        .filter((s) => s.isActive)
        .map(
          (s) =>
            `• ${s.key}: ${s.cpu} vCPU, ${s.memoryMb} MB RAM — Rp ${Number(s.pricePerDayIDR).toLocaleString()}/day`
        );
      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Resize Database ────────────────────────────────────────────────────────

server.tool(
  "resize_database",
  "Resize a database to a different instance size. The database will restart.",
  {
    databaseId: z.string().describe("The database ID"),
    instanceSize: z.enum(["micro", "small", "medium", "large", "xlarge"]).describe("New instance size"),
  },
  async ({ databaseId, instanceSize }) => {
    try {
      const db = await api("PATCH", `/orgs/${ORG_ID}/databases/${databaseId}/resize`, { instanceSize });
      return ok(`Database resized to ${instanceSize}.\n\n${fmtDb(db)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Backups ───────────────────────────────────────────────────────────

server.tool(
  "list_backups",
  "List all backups for a database.",
  {
    databaseId: z.string().describe("The database ID"),
  },
  async ({ databaseId }) => {
    try {
      const backups: R[] = await api("GET", `/orgs/${ORG_ID}/databases/${databaseId}/backups`);
      if (!backups.length) return ok("No backups yet.");
      const lines = backups.map((b) => `• ${fmtBackup(b)}`);
      return ok(`${backups.length} backup(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Trigger Backup ─────────────────────────────────────────────────────────

server.tool(
  "trigger_backup",
  "Trigger a manual backup for a database.",
  {
    databaseId: z.string().describe("The database ID"),
  },
  async ({ databaseId }) => {
    try {
      const backup: R = await api("POST", `/orgs/${ORG_ID}/databases/${databaseId}/backups`);
      return ok(`Backup triggered: ${fmtBackup(backup)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Restore Backup ─────────────────────────────────────────────────────────

server.tool(
  "restore_backup",
  "Restore a database from a backup. This will overwrite current data.",
  {
    databaseId: z.string().describe("The database ID"),
    backupId: z.string().describe("The backup ID to restore from"),
  },
  async ({ databaseId, backupId }) => {
    try {
      const job: R = await api(
        "POST",
        `/orgs/${ORG_ID}/databases/${databaseId}/backups/${backupId}/restore`,
        {}
      );
      return ok(`Restore started. Job ID: ${job.id}, Status: ${job.status}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Toggle Auto Backup ─────────────────────────────────────────────────────

server.tool(
  "toggle_backup",
  "Enable or disable automated daily backups for a database.",
  {
    databaseId: z.string().describe("The database ID"),
    enable: z.boolean().describe("true to enable, false to disable"),
  },
  async ({ databaseId, enable }) => {
    try {
      await api(
        "PATCH",
        `/orgs/${ORG_ID}/databases/${databaseId}/backup/${enable ? "enable" : "disable"}`
      );
      return ok(`Automated backup ${enable ? "enabled" : "disabled"}.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Replicas ──────────────────────────────────────────────────────────

server.tool(
  "list_replicas",
  "List read replicas for a database (PostgreSQL/MySQL only).",
  {
    databaseId: z.string().describe("The primary database ID"),
  },
  async ({ databaseId }) => {
    try {
      const replicas: R[] = await api("GET", `/orgs/${ORG_ID}/databases/${databaseId}/replicas`);
      if (!replicas.length) return ok("No replicas.");
      const lines = replicas.map((r) => `• ${r.name} (${r.id}) [${r.status}] — ${r.instanceSize}`);
      return ok(`${replicas.length} replica(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Create Replica ─────────────────────────────────────────────────────────

server.tool(
  "create_replica",
  "Create a read replica for a database (PostgreSQL/MySQL only).",
  {
    databaseId: z.string().describe("The primary database ID"),
    instanceSize: z
      .enum(["micro", "small", "medium", "large", "xlarge"])
      .optional()
      .describe("Instance size for the replica (default: same as primary)"),
  },
  async ({ databaseId, instanceSize }) => {
    try {
      const body: R = {};
      if (instanceSize) body.instanceSize = instanceSize;
      const replica = await api("POST", `/orgs/${ORG_ID}/databases/${databaseId}/replicas`, body);
      return ok(`Replica provisioning started.\n\n${fmtDb(replica)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Delete Replica ─────────────────────────────────────────────────────────

server.tool(
  "delete_replica",
  "Delete a read replica.",
  {
    databaseId: z.string().describe("The primary database ID"),
    replicaId: z.string().describe("The replica ID to delete"),
  },
  async ({ databaseId, replicaId }) => {
    try {
      await api("DELETE", `/orgs/${ORG_ID}/databases/${databaseId}/replicas/${replicaId}`);
      return ok("Replica deleted.");
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Add Custom Domain (App) ────────────────────────────────────────────────

server.tool(
  "add_app_domain",
  "Add a custom domain to an application. You must point a CNAME record to the app's default host first.",
  {
    appId: z.string().describe("The app ID"),
    domain: z.string().describe("Custom domain (e.g. app.example.com)"),
  },
  async ({ appId, domain }) => {
    try {
      const app = await api("POST", `/orgs/${ORG_ID}/apps/${appId}/domain`, { domain });
      return ok(`Custom domain added.\n\n${fmtApp(app)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Update App Settings ────────────────────────────────────────────────────

server.tool(
  "update_app_settings",
  "Update app build settings: branch, build path, port, or Docker image.",
  {
    appId: z.string().describe("The app ID"),
    branch: z.string().optional().describe("Git branch to deploy from"),
    buildPath: z.string().optional().describe("Build path (subdirectory)"),
    port: z.number().optional().describe("App port"),
    dockerImage: z.string().optional().describe("Docker image (for docker source)"),
  },
  async ({ appId, branch, buildPath, port, dockerImage }) => {
    try {
      const body: R = {};
      if (branch) body.branch = branch;
      if (buildPath) body.buildPath = buildPath;
      if (port) body.port = port;
      if (dockerImage) body.dockerImage = dockerImage;
      const app = await api("PATCH", `/orgs/${ORG_ID}/apps/${appId}/settings`, body);
      return ok(`Settings updated.\n\n${fmtApp(app)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get App Env Vars ───────────────────────────────────────────────────────

server.tool(
  "get_app_env_vars",
  "Get current environment variables for an application.",
  {
    appId: z.string().describe("The app ID"),
  },
  async ({ appId }) => {
    try {
      const data: R = await api("GET", `/orgs/${ORG_ID}/apps/${appId}/env`);
      const vars = (data.envVars ?? data) as Record<string, string>;
      const entries = Object.entries(vars);
      if (!entries.length) return ok("No environment variables set.");
      const lines = entries.map(([k, v]) => `${k}=${v}`);
      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Scale App ──────────────────────────────────────────────────────────────

server.tool(
  "scale_app",
  "Scale an app horizontally by adding or removing nodes, or vertically by resizing a node.",
  {
    appId: z.string().describe("The app ID"),
    action: z.enum(["add_node", "remove_node", "resize_node"]).describe("Scaling action"),
    instanceSize: z
      .enum(["micro", "small", "medium", "large", "xlarge"])
      .optional()
      .describe("Instance size (for add_node or resize_node)"),
    nodeId: z.string().optional().describe("Node ID (for remove_node or resize_node)"),
  },
  async ({ appId, action, instanceSize, nodeId }) => {
    try {
      if (action === "add_node") {
        const node = await api("POST", `/orgs/${ORG_ID}/apps/${appId}/nodes`, {
          instanceSize: instanceSize ?? "small",
        });
        return ok(`Node added: ${node.id} (${node.instanceSize}). Provisioning...`);
      }
      if (action === "remove_node") {
        if (!nodeId) return err("nodeId is required for remove_node.");
        await api("DELETE", `/orgs/${ORG_ID}/apps/${appId}/nodes/${nodeId}`);
        return ok("Node removed.");
      }
      if (action === "resize_node") {
        if (!nodeId) return err("nodeId is required for resize_node.");
        if (!instanceSize) return err("instanceSize is required for resize_node.");
        await api("PATCH", `/orgs/${ORG_ID}/apps/${appId}/nodes/${nodeId}/resize`, { instanceSize });
        return ok(`Node ${nodeId} resized to ${instanceSize}. App will redeploy.`);
      }
      return err("Unknown action.");
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List App Nodes ─────────────────────────────────────────────────────────

server.tool(
  "list_app_nodes",
  "List all nodes (instances) for a horizontally-scaled application.",
  {
    appId: z.string().describe("The app ID"),
  },
  async ({ appId }) => {
    try {
      const nodes: R[] = await api("GET", `/orgs/${ORG_ID}/apps/${appId}/nodes`);
      if (!nodes.length) return ok("No nodes.");
      const lines = nodes.map(
        (n) => `• Node #${n.nodeIndex} (${n.id}) [${n.status}] — ${n.instanceSize}`
      );
      return ok(`${nodes.length} node(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Deploy Service ─────────────────────────────────────────────────────────

server.tool(
  "deploy_service",
  "Deploy a managed service from a Docker image. Use list_service_images to see available images.",
  {
    name: z.string().min(3).describe("Service name (lowercase, alphanumeric)"),
    dockerImage: z.string().describe("Docker image (e.g. redis:7, memcached:latest)"),
    port: z.number().describe("Service port"),
    instanceSize: z
      .enum(["micro", "small", "medium", "large", "xlarge"])
      .optional()
      .describe("Instance size (default: small)"),
    envVars: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables"),
  },
  async ({ name, dockerImage, port, instanceSize, envVars }) => {
    try {
      const body: R = { name, dockerImage, port };
      if (instanceSize) body.instanceSize = instanceSize;
      if (envVars) body.envVars = envVars;
      const svc = await api("POST", `/orgs/${ORG_ID}/services`, body);
      return ok(`Service deploying!\n\n${fmtService(svc)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Services ──────────────────────────────────────────────────────────

server.tool(
  "list_services",
  "List all managed services in the organization.",
  {},
  async () => {
    try {
      const svcs: R[] = await api("GET", `/orgs/${ORG_ID}/services`);
      if (!svcs.length) return ok("No services yet.");
      const lines = svcs.map(
        (s) => `• ${s.name} (${s.id}) [${s.status}] — ${s.dockerImage} — ${s.instanceSize}`
      );
      return ok(`${svcs.length} service(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get Service Info ───────────────────────────────────────────────────────

server.tool(
  "get_service_info",
  "Get detailed info about a managed service.",
  {
    serviceId: z.string().describe("The service ID"),
  },
  async ({ serviceId }) => {
    try {
      const svc = await api("GET", `/orgs/${ORG_ID}/services/${serviceId}`);
      return ok(fmtService(svc));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Manage Service ─────────────────────────────────────────────────────────

server.tool(
  "manage_service",
  "Start, stop, restart, or redeploy a managed service.",
  {
    serviceId: z.string().describe("The service ID"),
    action: z.enum(["start", "stop", "restart", "redeploy"]).describe("Action to perform"),
  },
  async ({ serviceId, action }) => {
    try {
      await api("POST", `/orgs/${ORG_ID}/services/${serviceId}/${action}`);
      return ok(`Service ${action} initiated.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Delete Service ─────────────────────────────────────────────────────────

server.tool(
  "delete_service",
  "Delete a managed service. This is irreversible.",
  {
    serviceId: z.string().describe("The service ID to delete"),
  },
  async ({ serviceId }) => {
    try {
      await api("DELETE", `/orgs/${ORG_ID}/services/${serviceId}`);
      return ok("Service deleted.");
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Update Service Env Vars ────────────────────────────────────────────────

server.tool(
  "update_service_env_vars",
  "Update environment variables for a managed service. Triggers a redeploy.",
  {
    serviceId: z.string().describe("The service ID"),
    envVars: z.record(z.string(), z.string()).describe("Environment variables to set"),
  },
  async ({ serviceId, envVars }) => {
    try {
      await api("PATCH", `/orgs/${ORG_ID}/services/${serviceId}/env`, { envVars });
      const keys = Object.keys(envVars);
      return ok(`Updated ${keys.length} env var(s): ${keys.join(", ")}\nService will redeploy.`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Add Service Domain ─────────────────────────────────────────────────────

server.tool(
  "add_service_domain",
  "Add a custom domain to a managed service.",
  {
    serviceId: z.string().describe("The service ID"),
    domain: z.string().describe("Custom domain (e.g. svc.example.com)"),
  },
  async ({ serviceId, domain }) => {
    try {
      const svc = await api("POST", `/orgs/${ORG_ID}/services/${serviceId}/domain`, { domain });
      return ok(`Custom domain added.\n\n${fmtService(svc)}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get Service Logs ───────────────────────────────────────────────────────

server.tool(
  "get_service_logs",
  "Get recent logs for a managed service.",
  {
    serviceId: z.string().describe("The service ID"),
    tail: z.number().optional().describe("Number of recent lines (default: 100)"),
  },
  async ({ serviceId, tail }) => {
    try {
      const t = tail ?? 100;
      const res = await fetch(
        `${API_BASE}/orgs/${ORG_ID}/services/${serviceId}/logs/live?tail=${t}`,
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
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Service Images ────────────────────────────────────────────────────

server.tool(
  "list_service_images",
  "List pre-configured Docker images available for service deployment (e.g. Redis, Memcached).",
  {},
  async () => {
    try {
      const data: R = await api("GET", `/orgs/${ORG_ID}/services/images`);
      const images = (data.images ?? data) as R[];
      if (!images.length) return ok("No service images available.");
      const lines = images.map(
        (i) => `• ${i.name}: ${i.image} — ${i.description} (port ${i.defaultPort})`
      );
      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── List Git Repos ─────────────────────────────────────────────────────────

server.tool(
  "list_git_repos",
  "List available GitHub/GitLab repositories connected to the organization. Useful to browse repos before deploying an app.",
  {},
  async () => {
    try {
      const repos: R[] = await api("GET", `/orgs/${ORG_ID}/git-repos`);
      if (!repos.length) return ok("No repositories found. Make sure a Git token is configured in org settings.");
      const lines = repos.map(
        (r) => `• ${r.fullName} (${r.defaultBranch}) ${r.private ? "[private]" : "[public]"}`
      );
      return ok(`${repos.length} repo(s):\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get Database Health ────────────────────────────────────────────────────

server.tool(
  "get_database_health",
  "Get health metrics for a database: CPU, memory, disk, connections, connectivity, and cache hit ratio.",
  {
    databaseId: z.string().describe("The database ID"),
  },
  async ({ databaseId }) => {
    try {
      const h: R = await api("GET", `/orgs/${ORG_ID}/monitoring/health/${databaseId}`);
      if (!h) return ok("No health data available yet.");
      return ok(
        [
          `Status: ${h.status}`,
          h.cpuPercent != null ? `CPU: ${h.cpuPercent}%` : null,
          h.memoryPercent != null ? `Memory: ${h.memoryPercent}%` : null,
          h.diskPercent != null ? `Disk: ${h.diskPercent}%` : null,
          h.connections != null ? `Connections: ${h.connections}` : null,
          h.connectivityMs != null ? `Connectivity: ${h.connectivityMs}ms` : null,
          h.dbSizeMb != null ? `DB Size: ${h.dbSizeMb} MB` : null,
          h.cacheHitRatio != null ? `Cache Hit: ${(Number(h.cacheHitRatio) * 100).toFixed(1)}%` : null,
          h.connectivityError ? `Error: ${h.connectivityError}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      return err(`Failed: ${(e as Error).message}`);
    }
  }
);

// ── Get Deployment Logs ────────────────────────────────────────────────────

server.tool(
  "get_deployment_logs",
  "Get build/deployment logs for a specific deployment of an app.",
  {
    appId: z.string().describe("The app ID"),
    deploymentId: z.string().optional().describe("Deployment ID (omit to get the latest)"),
  },
  async ({ appId, deploymentId }) => {
    try {
      let depId = deploymentId;
      if (!depId) {
        const deps: R[] = await api("GET", `/orgs/${ORG_ID}/apps/${appId}/deployments`);
        if (!deps.length) return ok("No deployments found.");
        depId = deps[0].id as string;
      }
      const data: R = await api(
        "GET",
        `/orgs/${ORG_ID}/apps/${appId}/deployments/${depId}/logs`
      );
      const logs = (data.logs as string) ?? "";
      return ok(logs || "No logs available.");
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
