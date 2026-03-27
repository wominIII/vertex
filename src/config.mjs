import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  host: "0.0.0.0",
  port: 8787,
  location: "global",
  defaultModel: "gemini-3.1-pro-preview",
  logLevel: "debug",
  modelCacheTtlMs: 300000,
  tokenSkewMs: 60000,
  includeThoughts: true,
  thoughtsMode: "reasoning_content",
  thinkingBudget: 1024,
  maxFetchAttempts: 2,
  fetchRetryDelayMs: 500,
  oauthTokenUrl: "https://oauth2.googleapis.com/token",
  vertexApiBaseUrl: "https://aiplatform.googleapis.com",
  publisherModelsBaseUrl: "https://aiplatform.googleapis.com",
};

const SUPPORTED_LOG_LEVELS = new Set(["error", "info", "debug"]);
const SUPPORTED_THOUGHTS_MODES = new Set(["reasoning_content", "content", "off"]);

export function createConfig({ cwd = process.cwd(), env = process.env } = {}) {
  loadEnvFile(cwd, env);

  const credentialsInfo = resolveCredentials(cwd, env);
  const config = {
    cwd,
    host: env.HOST || DEFAULTS.host,
    port: parseInteger(env.PORT, DEFAULTS.port),
    location: env.VERTEX_LOCATION || DEFAULTS.location,
    projectId: env.VERTEX_PROJECT_ID || credentialsInfo.credentials.project_id,
    defaultModel: env.VERTEX_MODEL || DEFAULTS.defaultModel,
    inboundApiKey: env.OPENAI_API_KEY || "",
    modelAliases: parseList(env.MODEL_ALIASES),
    modelCacheTtlMs: parseInteger(env.MODEL_CACHE_TTL_MS, DEFAULTS.modelCacheTtlMs),
    logLevel: env.LOG_LEVEL || DEFAULTS.logLevel,
    tokenSkewMs: parseInteger(env.TOKEN_SKEW_MS, DEFAULTS.tokenSkewMs),
    includeThoughts: parseBoolean(env.INCLUDE_THOUGHTS, DEFAULTS.includeThoughts),
    thoughtsMode: env.THOUGHTS_MODE || DEFAULTS.thoughtsMode,
    thinkingBudget: parseInteger(env.THINKING_BUDGET, DEFAULTS.thinkingBudget),
    maxFetchAttempts: parseInteger(env.MAX_FETCH_ATTEMPTS, DEFAULTS.maxFetchAttempts),
    fetchRetryDelayMs: parseInteger(env.FETCH_RETRY_DELAY_MS, DEFAULTS.fetchRetryDelayMs),
    oauthTokenUrl: trimTrailingSlash(
      env.GOOGLE_OAUTH_TOKEN_URL || credentialsInfo.credentials.token_uri || DEFAULTS.oauthTokenUrl,
    ),
    vertexApiBaseUrl: trimTrailingSlash(env.VERTEX_API_BASE_URL || DEFAULTS.vertexApiBaseUrl),
    publisherModelsBaseUrl: trimTrailingSlash(
      env.PUBLISHER_MODELS_BASE_URL || DEFAULTS.publisherModelsBaseUrl,
    ),
    credentials: credentialsInfo.credentials,
    credentialsSource: credentialsInfo.source,
  };

  validateConfig(config);
  return config;
}

export function formatStartupSummary(config) {
  return {
    host: config.host,
    port: config.port,
    projectId: config.projectId,
    location: config.location,
    defaultModel: config.defaultModel,
    modelAliases: config.modelAliases,
    inboundApiKey: maskSecret(config.inboundApiKey),
    includeThoughts: config.includeThoughts,
    thoughtsMode: config.thoughtsMode,
    thinkingBudget: config.thinkingBudget,
    maxFetchAttempts: config.maxFetchAttempts,
    fetchRetryDelayMs: config.fetchRetryDelayMs,
    credentialsSource: config.credentialsSource,
  };
}

function validateConfig(config) {
  if (!config.projectId) {
    throw new Error("Missing Vertex project id. Set VERTEX_PROJECT_ID or provide a valid service account.");
  }

  if (!SUPPORTED_LOG_LEVELS.has(config.logLevel)) {
    throw new Error(`Unsupported LOG_LEVEL: ${config.logLevel}`);
  }

  if (!SUPPORTED_THOUGHTS_MODES.has(config.thoughtsMode)) {
    throw new Error(`Unsupported THOUGHTS_MODE: ${config.thoughtsMode}`);
  }

  if (config.port <= 0) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }
}

function loadEnvFile(cwd, env) {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const delimiterIndex = trimmed.indexOf("=");
    if (delimiterIndex <= 0) continue;

    const key = trimmed.slice(0, delimiterIndex).trim();
    let value = trimmed.slice(delimiterIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in env)) {
      env[key] = value;
    }
  }
}

function resolveCredentials(cwd, env) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    return {
      credentials: parseCredentialsJson(
        env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
      ),
      source: "inline env GOOGLE_APPLICATION_CREDENTIALS_JSON",
    };
  }

  const explicitPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  const resolvedPath = explicitPath || findServiceAccountFile(cwd) || failMissingCredentials();

  return {
    credentials: parseCredentialsJson(readFileSync(resolvedPath, "utf8"), resolvedPath),
    source: resolvedPath,
  };
}

function findServiceAccountFile(cwd) {
  const preferred = join(cwd, "service-account.json");
  if (existsSync(preferred)) {
    return preferred;
  }

  const jsonFile = readdirSync(cwd).find((file) => {
    if (!file.endsWith(".json")) return false;
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, file), "utf8"));
      return parsed.type === "service_account" && parsed.private_key;
    } catch {
      return false;
    }
  });

  return jsonFile ? join(cwd, jsonFile) : "";
}

function parseCredentialsJson(raw, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse service account credentials from ${sourceLabel}: ${error.message}`);
  }

  if (parsed?.type !== "service_account" || !parsed?.private_key || !parsed?.client_email) {
    throw new Error(`Credentials from ${sourceLabel} are not a valid service account JSON.`);
  }

  return parsed;
}

function failMissingCredentials() {
  throw new Error(
    "No service account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS, set GOOGLE_APPLICATION_CREDENTIALS_JSON, or place service-account.json in the project root.",
  );
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function maskSecret(value) {
  if (!value) return "(disabled)";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
