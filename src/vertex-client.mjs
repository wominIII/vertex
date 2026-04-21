import { createSign } from "node:crypto";
import { proxyFetch } from "./proxy-fetch.mjs";

export function createVertexClient({ config, logger }) {
  let cachedAccessToken = "";
  let accessTokenExpiresAt = 0;
  let cachedModels = [];
  let modelCacheExpiresAt = 0;

  return {
    callModel,
    predictModel,
    synthesizeSpeech,
    rankRecords,
    fetchAvailableModels,
    resetCaches,
  };

  async function callModel(model, payload, { stream }) {
    assertVertexConfigured();
    const token = await getAccessToken();
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url =
      `${config.vertexApiBaseUrl}/v1/projects/${config.projectId}` +
      `/locations/${config.location}/publishers/google/models/${model}:${method}`;

    logger.debug("Forwarding request to Vertex", {
      model,
      stream,
      location: config.location,
      url,
    });

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      `vertex-${stream ? "stream" : "generate"}-${model}`,
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("Vertex request failed", {
        model,
        stream,
        status: response.status,
        body,
      });
      throw new Error(`Vertex error ${response.status}: ${body}`);
    }

    logger.debug("Vertex request succeeded", {
      model,
      stream,
      status: response.status,
    });

    return response;
  }

  async function predictModel(model, payload) {
    assertVertexConfigured();
    const token = await getAccessToken();
    const url =
      `${config.vertexApiBaseUrl}/v1/projects/${config.projectId}` +
      `/locations/${config.location}/publishers/google/models/${model}:predict`;

    logger.debug("Forwarding predict request to Vertex", {
      model,
      location: config.location,
      url,
    });

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      `vertex-predict-${model}`,
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("Vertex predict request failed", {
        model,
        status: response.status,
        body,
      });
      throw new Error(`Vertex predict error ${response.status}: ${body}`);
    }

    return response;
  }

  async function synthesizeSpeech(payload) {
    assertVertexConfigured();
    const token = await getAccessToken();
    const url = `${config.textToSpeechApiBaseUrl}/v1/text:synthesize`;

    logger.debug("Forwarding speech request to Cloud Text-to-Speech", {
      url,
      model: payload?.voice?.modelName || payload?.voice?.model_name || "",
    });

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Goog-User-Project": config.projectId,
        },
        body: JSON.stringify(payload),
      },
      "text-to-speech-synthesize",
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("Cloud Text-to-Speech request failed", {
        status: response.status,
        body,
      });
      throw new Error(`Text-to-Speech error ${response.status}: ${body}`);
    }

    return response;
  }

  async function rankRecords(payload) {
    assertVertexConfigured();
    const token = await getAccessToken();
    const url =
      `${config.discoveryEngineApiBaseUrl}/v1/projects/${config.projectId}` +
      `/locations/${config.rerankLocation}/rankingConfigs/default_ranking_config:rank`;

    logger.debug("Forwarding rank request to Discovery Engine", {
      url,
      model: payload?.model || "",
      records: Array.isArray(payload?.records) ? payload.records.length : 0,
    });

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Goog-User-Project": config.projectId,
        },
        body: JSON.stringify(payload),
      },
      "discovery-engine-rank",
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("Discovery Engine rank request failed", {
        status: response.status,
        body,
      });
      throw new Error(`Rerank error ${response.status}: ${body}`);
    }

    return response;
  }

  async function fetchAvailableModels(forceRefresh = false) {
    assertVertexConfigured();
    const now = Date.now();
    if (!forceRefresh && cachedModels.length && now < modelCacheExpiresAt) {
      return cachedModels;
    }

    const token = await getAccessToken();
    const modelIds = new Set([
      config.defaultModel,
      config.defaultEmbeddingModel,
      config.defaultImageModel,
      config.defaultTtsModel,
      config.defaultRerankModel,
    ].filter(Boolean));
    let pageToken = "";

    while (true) {
      const query = new URLSearchParams({ listAllVersions: "true" });
      if (pageToken) query.set("pageToken", pageToken);

      const url = `${config.publisherModelsBaseUrl}/v1beta1/publishers/google/models?${query.toString()}`;
      const response = await fetchWithRetry(
        url,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
        "publisher-model-list",
      );

      if (!response.ok) {
        throw new Error(`Model list failed with status ${response.status}: ${await response.text()}`);
      }

      const payload = await response.json();
      for (const item of payload.publisherModels || []) {
        const fullName = item?.name;
        if (typeof fullName !== "string") continue;
        const modelId = fullName.split("/").pop();
        if (!modelId || !modelId.startsWith("gemini-")) continue;
        modelIds.add(modelId);
      }

      pageToken = payload.nextPageToken || "";
      if (!pageToken) break;
    }

    cachedModels = Array.from(modelIds).sort((a, b) => a.localeCompare(b));
    modelCacheExpiresAt = now + config.modelCacheTtlMs;
    return cachedModels;
  }

  async function getAccessToken() {
    assertVertexConfigured();
    if (cachedAccessToken && Date.now() < accessTokenExpiresAt - config.tokenSkewMs) {
      logger.debug("Using cached Google access token", {
        expiresAt: new Date(accessTokenExpiresAt).toISOString(),
      });
      return cachedAccessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const unsignedToken = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
      iss: config.credentials.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: config.oauthTokenUrl,
      exp: now + 3600,
      iat: now,
    })}`;

    const signer = createSign("RSA-SHA256");
    signer.update(unsignedToken);
    signer.end();

    const signature = signer
      .sign(config.credentials.private_key)
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    logger.debug("Requesting new Google access token", {
      tokenUri: config.oauthTokenUrl,
      clientEmail: config.credentials.client_email,
    });

    const response = await fetchWithRetry(
      config.oauthTokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsignedToken}.${signature}`,
        }),
      },
      "google-access-token",
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error("Google access token request failed", {
        status: response.status,
        body,
      });
      throw new Error(`Token request failed with status ${response.status}: ${body}`);
    }

    const payload = await response.json();
    cachedAccessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;

    logger.debug("Received new Google access token", {
      expiresAt: new Date(accessTokenExpiresAt).toISOString(),
    });

    return cachedAccessToken;
  }

  function resetCaches() {
    cachedAccessToken = "";
    accessTokenExpiresAt = 0;
    cachedModels = [];
    modelCacheExpiresAt = 0;
  }

  async function fetchWithRetry(url, options, label) {
    let lastError;

    for (let attempt = 1; attempt <= config.maxFetchAttempts; attempt += 1) {
      try {
        if (attempt > 1) {
          logger.info("Retrying fetch", {
            label,
            attempt,
            url,
          });
        }

        return await fetchWithOptionalProxy(url, options);
      } catch (error) {
        lastError = error;
        logger.error("Fetch attempt failed", {
          label,
          attempt,
          url,
          error: error.message,
          cause: error.cause?.message || String(error.cause || ""),
        });

        if (attempt < config.maxFetchAttempts) {
          await new Promise((resolve) => setTimeout(resolve, config.fetchRetryDelayMs));
        }
      }
    }

    throw lastError;
  }

  function fetchWithOptionalProxy(url, options) {
    if (!config.outboundProxyUrl) {
      return fetch(url, options);
    }

    logger.debug("Using outbound proxy", {
      url,
      proxy: maskProxyUrl(config.outboundProxyUrl),
    });
    return proxyFetch(url, options, config.outboundProxyUrl);
  }

  function assertVertexConfigured() {
    if (!config.credentials?.client_email || !config.credentials?.private_key) {
      throw new Error(
        "Vertex credentials are not configured yet. Start the server, open /admin, and import your service account JSON first.",
      );
    }

    if (!config.projectId) {
      throw new Error(
        "Vertex project id is missing. Import a valid service account JSON in /admin or set VERTEX_PROJECT_ID.",
      );
    }
  }
}

function maskProxyUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}

function base64url(input) {
  const raw =
    typeof input === "string" ? Buffer.from(input) : Buffer.from(JSON.stringify(input));
  return raw
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
