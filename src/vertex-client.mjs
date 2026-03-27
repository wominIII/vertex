import { createSign } from "node:crypto";

export function createVertexClient({ config, logger }) {
  let cachedAccessToken = "";
  let accessTokenExpiresAt = 0;
  let cachedModels = [];
  let modelCacheExpiresAt = 0;

  return {
    callModel,
    fetchAvailableModels,
  };

  async function callModel(model, payload, { stream }) {
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

  async function fetchAvailableModels(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedModels.length && now < modelCacheExpiresAt) {
      return cachedModels;
    }

    const token = await getAccessToken();
    const modelIds = new Set([config.defaultModel]);
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

        return await fetch(url, options);
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
