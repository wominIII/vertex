import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toRelativeCredentialPath } from "./config.mjs";

export function createAdminUi({ config, logger, vertexClient }) {
  const uiRoot = join(config.cwd, "ui");

  return {
    handleRequest,
  };

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/admin") {
      return serveStatic(res, join(uiRoot, "index.html"), "text/html; charset=utf-8");
    }

    if (pathname === "/ui/app.js") {
      return serveStatic(res, join(uiRoot, "app.js"), "text/javascript; charset=utf-8");
    }

    if (pathname === "/ui/styles.css") {
      return serveStatic(res, join(uiRoot, "styles.css"), "text/css; charset=utf-8");
    }

    if (!pathname.startsWith("/api/admin/")) {
      return false;
    }

    if (!isAdminAuthorized(req, config.adminPassword)) {
      return sendJson(res, 401, {
        error: {
          message: "Admin API key required or invalid.",
          type: "authentication_error",
        },
      });
    }

    if (req.method === "GET" && pathname === "/api/admin/config") {
      return sendJson(res, 200, {
        config: serializeConfig(config),
        notes: {
          requiresRestartFor: ["host", "port"],
          defaultAdminPassword: "vertex-admin",
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/admin/config") {
      const body = await readJsonBody(req);
      applyConfigUpdates(config, body);
      persistEnvFile(config);
      vertexClient.resetCaches();
      logger.info("Admin UI updated configuration", serializeConfig(config));
      return sendJson(res, 200, {
        ok: true,
        config: serializeConfig(config),
        message: "Configuration saved. Host/port changes require a restart.",
      });
    }

    if (req.method === "GET" && pathname === "/api/admin/models") {
      const models = await vertexClient.fetchAvailableModels(url.searchParams.get("refresh") === "1");
      return sendJson(res, 200, {
        ok: true,
        count: models.length,
        models,
      });
    }

    if (req.method === "POST" && pathname === "/api/admin/import-credentials") {
      const body = await readJsonBody(req);
      const credentials = JSON.parse(body.jsonText || "");
      validateServiceAccountJson(credentials);

      const credentialPath = join(config.cwd, "service-account.json");
      writeFileSync(credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");

      config.credentials = credentials;
      config.credentialsSource = credentialPath;
      config.projectId = credentials.project_id;

      persistEnvFile(config);
      vertexClient.resetCaches();
      logger.info("Admin UI imported service account JSON", {
        credentialPath,
        projectId: config.projectId,
      });

      return sendJson(res, 200, {
        ok: true,
        config: serializeConfig(config),
        message: "Credentials imported to service-account.json. A restart is recommended.",
      });
    }

    if (req.method === "POST" && pathname === "/api/admin/password") {
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "").trim();

      if (currentPassword !== config.adminPassword) {
        return sendJson(res, 400, {
          error: {
            message: "Current admin password is incorrect.",
            type: "invalid_request_error",
          },
        });
      }

      if (newPassword.length < 6) {
        return sendJson(res, 400, {
          error: {
            message: "New admin password must be at least 6 characters.",
            type: "invalid_request_error",
          },
        });
      }

      config.adminPassword = newPassword;
      persistEnvFile(config);
      logger.info("Admin UI changed admin password");

      return sendJson(res, 200, {
        ok: true,
        message: "Admin password updated.",
      });
    }

    return sendJson(res, 404, {
      error: {
        message: `Admin route not found: ${req.method} ${pathname}`,
        type: "not_found_error",
      },
    });
  }
}

function serializeConfig(config) {
  return {
    host: config.host,
    port: config.port,
    location: config.location,
    defaultTemperature: config.defaultTemperature,
    defaultTopP: config.defaultTopP,
    defaultTopK: config.defaultTopK,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens,
    inboundApiKey: config.inboundApiKey,
    adminPasswordEnabled: Boolean(config.adminPassword),
    logLevel: config.logLevel,
    includeThoughts: config.includeThoughts,
    enableStreaming: config.enableStreaming,
    thoughtsMode: config.thoughtsMode,
    thinkingBudget: config.thinkingBudget,
    maxFetchAttempts: config.maxFetchAttempts,
    fetchRetryDelayMs: config.fetchRetryDelayMs,
    credentialsSource: config.credentialsSource,
    credentialsClientEmail: config.credentials?.client_email || "",
  };
}

function applyConfigUpdates(config, body) {
  if (typeof body.host === "string" && body.host.trim()) config.host = body.host.trim();
  if (body.port !== undefined) config.port = toInt(body.port, config.port);
  if (typeof body.location === "string" && body.location.trim()) config.location = body.location.trim();
  if (body.defaultTemperature !== undefined) {
    config.defaultTemperature = toOptionalNumber(body.defaultTemperature, config.defaultTemperature);
  }
  if (body.defaultTopP !== undefined) {
    config.defaultTopP = toOptionalNumber(body.defaultTopP, config.defaultTopP);
  }
  if (body.defaultTopK !== undefined) {
    config.defaultTopK = toOptionalNumber(body.defaultTopK, config.defaultTopK);
  }
  if (body.defaultMaxOutputTokens !== undefined) {
    config.defaultMaxOutputTokens = toOptionalNumber(
      body.defaultMaxOutputTokens,
      config.defaultMaxOutputTokens,
    );
  }
  if (body.inboundApiKey !== undefined) config.inboundApiKey = String(body.inboundApiKey || "");
  if (typeof body.logLevel === "string" && body.logLevel.trim()) config.logLevel = body.logLevel.trim();
  if (body.includeThoughts !== undefined) config.includeThoughts = Boolean(body.includeThoughts);
  if (body.enableStreaming !== undefined) config.enableStreaming = Boolean(body.enableStreaming);
  if (typeof body.thoughtsMode === "string" && body.thoughtsMode.trim()) {
    config.thoughtsMode = body.thoughtsMode.trim();
  }
  if (body.thinkingBudget !== undefined) config.thinkingBudget = toInt(body.thinkingBudget, config.thinkingBudget);
  if (body.maxFetchAttempts !== undefined) {
    config.maxFetchAttempts = toInt(body.maxFetchAttempts, config.maxFetchAttempts);
  }
  if (body.fetchRetryDelayMs !== undefined) {
    config.fetchRetryDelayMs = toInt(body.fetchRetryDelayMs, config.fetchRetryDelayMs);
  }
}

function persistEnvFile(config) {
  const envPath = join(config.cwd, ".env");
  const content = [
    `HOST=${config.host}`,
    `PORT=${config.port}`,
    "",
    "# Pick one credentials mode:",
    "# 1) Local file path",
    `GOOGLE_APPLICATION_CREDENTIALS=${toRelativeCredentialPath(config)}`,
    "# 2) Inline JSON",
    "# GOOGLE_APPLICATION_CREDENTIALS_JSON={\"type\":\"service_account\",\"project_id\":\"...\"}",
    "",
    `VERTEX_PROJECT_ID=${config.projectId}`,
    `VERTEX_LOCATION=${config.location}`,
    `VERTEX_MODEL=${config.defaultModel}`,
    `DEFAULT_TEMPERATURE=${toEnvValue(config.defaultTemperature)}`,
    `DEFAULT_TOP_P=${toEnvValue(config.defaultTopP)}`,
    `DEFAULT_TOP_K=${toEnvValue(config.defaultTopK)}`,
    `DEFAULT_MAX_OUTPUT_TOKENS=${toEnvValue(config.defaultMaxOutputTokens)}`,
    "",
    "# Optional Bearer key required by clients talking to this proxy.",
    `OPENAI_API_KEY=${config.inboundApiKey}`,
    "",
    "# Password for the local admin web console.",
    `ADMIN_PASSWORD=${config.adminPassword}`,
    "",
    "# Logging and retry behavior",
    `LOG_LEVEL=${config.logLevel}`,
    `MAX_FETCH_ATTEMPTS=${config.maxFetchAttempts}`,
    `FETCH_RETRY_DELAY_MS=${config.fetchRetryDelayMs}`,
    "",
    "# Thought exposure",
    `INCLUDE_THOUGHTS=${config.includeThoughts}`,
    `ENABLE_STREAMING=${config.enableStreaming}`,
    `THOUGHTS_MODE=${config.thoughtsMode}`,
    `THINKING_BUDGET=${config.thinkingBudget}`,
    "",
  ].join("\n");

  writeFileSync(envPath, content, "utf8");
}

function serveStatic(res, filePath, contentType) {
  if (!existsSync(filePath)) {
    return sendJson(res, 404, {
      error: {
        message: `Static file not found: ${filePath}`,
        type: "not_found_error",
      },
    });
  }

  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
  return true;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function isAdminAuthorized(req, expectedPassword) {
  if (!expectedPassword) return true;
  const headerPassword = req.headers["x-admin-password"] || "";
  const bearer = req.headers.authorization || "";
  return headerPassword === expectedPassword || bearer === `Bearer ${expectedPassword}`;
}

function validateServiceAccountJson(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Imported JSON is empty or invalid.");
  }
  if (value.type !== "service_account" || !value.private_key || !value.client_email) {
    throw new Error("Imported JSON is not a valid service account.");
  }
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toEnvValue(value) {
  return value === null || value === undefined ? "" : value;
}
