import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createSseParser } from "./sse.mjs";
import { createAdminUi } from "./admin-ui.mjs";

export function createProxyServer({ config, logger, vertexClient, bridge }) {
  const adminUi = createAdminUi({ config, logger, vertexClient, bridge });

  return createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID().slice(0, 8);
    const clientIp = getClientIp(req);
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      logger.info(`REQ ${requestId} START ${req.method} ${req.url} from ${clientIp}`);
      logger.info("HTTP request started", {
        requestId,
        method: req.method,
        url: req.url,
        clientIp,
        userAgent: req.headers["user-agent"] || "",
      });

      if (req.method === "OPTIONS") {
        writeCors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (await adminUi.handleRequest(req, res)) {
        return;
      }

      if (!isAuthorized(req, config.inboundApiKey)) {
        logger.error("Request rejected due to invalid API key", {
          requestId,
          method: req.method,
          url: req.url,
        });
        sendError(res, 401, "Invalid proxy API key.", "authentication_error", logger);
        return;
      }

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(
          res,
          200,
          {
            ok: true,
            host: config.host,
            project: config.projectId,
            model: config.defaultModel,
          },
          logger,
        );
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        const modelIds = await vertexClient.fetchAvailableModels(
          url.searchParams.get("refresh") === "1",
        );

        logger.info("Returned model list", { count: modelIds.length });
        sendJson(
          res,
          200,
          {
            object: "list",
            data: modelIds.map((modelId) => ({
              id: modelId,
              object: "model",
              owned_by: "google-vertex-ai",
            })),
          },
          logger,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        await handleChatCompletions(req, res, {
          config,
          logger,
          vertexClient,
          bridge,
          requestId,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/embeddings") {
        await handleEmbeddings(req, res, { logger, vertexClient, bridge, requestId });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/images/generations") {
        await handleImageGenerations(req, res, { logger, vertexClient, bridge, requestId });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/audio/speech") {
        await handleAudioSpeech(req, res, { logger, vertexClient, bridge, requestId });
        return;
      }

      if (req.method === "POST" && (pathname === "/v1/rerank" || pathname === "/v1/rank")) {
        await handleRerank(req, res, { logger, vertexClient, bridge, requestId });
        return;
      }

      sendError(
        res,
        404,
        `Route not found: ${req.method} ${req.url}`,
        "not_found_error",
        logger,
      );
    } catch (error) {
      logger.error("Request failed", {
        requestId,
        method: req.method,
        url: req.url,
        error: error.message,
        cause: error.cause?.message || String(error.cause || ""),
        stack: error.stack,
      });

      if (!res.headersSent && !res.writableEnded) {
        sendError(
          res,
          Number.isInteger(error.statusCode) ? error.statusCode : 500,
          error.message,
          error.type || "server_error",
          logger,
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      logger.info(`REQ ${requestId} END ${req.method} ${req.url} in ${Date.now() - startedAt}ms`);
      logger.info("HTTP request finished", {
        requestId,
        method: req.method,
        url: req.url,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

async function handleChatCompletions(req, res, { config, logger, vertexClient, bridge, requestId }) {
  const body = await readJsonBody(req);
  const requestedModel =
    typeof body.model === "string" && body.model.trim() ? body.model : config.defaultModel;
  const vertexModel = resolveVertexModel(requestedModel, config);
  const vertexPayload = await bridge.toVertexPayload(body);
  const requestedStream = Boolean(body.stream);
  const isStream = config.enableStreaming && requestedStream;

  logger.info(
    `REQ ${requestId} CHAT model=${requestedModel} vertex=${vertexModel} stream=${isStream} messages=${
      Array.isArray(body.messages) ? body.messages.length : 0
    }`,
  );
  logger.info("Incoming chat completion", {
    requestId,
    requestedModel,
    vertexModel,
    requestedStream,
    streamingEnabled: config.enableStreaming,
    stream: isStream,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
  });

  if (!isStream) {
    const response = await vertexClient.callModel(vertexModel, vertexPayload, { stream: false });
    const payload = await response.json();
    const candidate = payload.candidates?.[0] || {};
    const parts = candidate?.content?.parts || [];

    bridge.rememberAssistantParts(parts);

    const completion = bridge.makeChatCompletion({
      requestModel: requestedModel,
      vertexModel,
      candidate,
      usage: payload.usageMetadata,
    });

    logger.info(`REQ ${requestId} CHAT OK finish=${candidate.finishReason || "UNKNOWN"}`);
    logger.info("Completed chat completion", {
      requestId,
      requestedModel,
      vertexModel,
      finishReason: candidate.finishReason || "UNKNOWN",
    });

    sendJson(res, 200, completion, logger);
    return;
  }

  await streamChatCompletion(req, res, {
    requestedModel,
    vertexModel,
    vertexPayload,
    logger,
    vertexClient,
    bridge,
    requestId,
  });
}

async function streamChatCompletion(
  req,
  res,
  { requestedModel, vertexModel, vertexPayload, logger, vertexClient, bridge, requestId },
) {
  const response = await vertexClient.callModel(vertexModel, vertexPayload, { stream: true });
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const accumulatedParts = [];
  let finalCandidate = {};
  let emittedRole = false;
  let clientClosed = false;
  let eventCount = 0;
  let sawToolCalls = false;

  req.on("close", () => {
    clientClosed = true;
  });
  res.on("close", () => {
    clientClosed = true;
  });

  writeCors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  logger.info(`REQ ${requestId} STREAM OPEN model=${requestedModel}`);
  logger.info("Streaming chat completion ready", {
    requestId,
    requestedModel,
    vertexModel,
    note: "headers-sent",
  });

  const parser = createSseParser((event) => {
    if (clientClosed || res.writableEnded) return;

    const candidate = event?.candidates?.[0] || {};
    if (candidate.finishReason) {
      finalCandidate = candidate;
    }

    if (!candidate?.content?.parts?.length) {
      return;
    }

    eventCount += 1;
    accumulatedParts.push(...candidate.content.parts);
    if (candidate.content.parts.some((part) => part?.functionCall)) {
      sawToolCalls = true;
    }

    const chunks = bridge.buildStreamingChunks({
      requestModel: requestedModel,
      candidate,
      created,
      completionId,
      emitRole: !emittedRole,
    });

    if (!emittedRole && chunks.length) {
      emittedRole = true;
    }

    for (const chunk of chunks) {
      writeSse(res, chunk);
    }
  });

  try {
    while (reader && !clientClosed) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }

    parser.push(decoder.decode());
    parser.flush();
    bridge.rememberAssistantParts(accumulatedParts);

    if (!res.writableEnded) {
      writeSse(
        res,
        bridge.buildStreamFinalChunk({
          requestModel: requestedModel,
          created,
          completionId,
          finishReason: finalCandidate.finishReason,
          hasToolCalls: sawToolCalls,
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }

    logger.info(
      `REQ ${requestId} STREAM DONE finish=${finalCandidate.finishReason || "UNKNOWN"} events=${eventCount}`,
    );
    logger.info("Streaming chat completion sent", {
      requestId,
      requestedModel,
      vertexModel,
      finishReason: finalCandidate.finishReason || "UNKNOWN",
      eventCount,
    });
  } catch (error) {
    logger.error(
      `REQ ${requestId} STREAM ERROR ${error.message}${error.cause ? ` (${error.cause.message || String(error.cause)})` : ""}`,
    );
    logger.error("Streaming chat completion aborted", {
      requestId,
      requestedModel,
      vertexModel,
      error: error.message,
      cause: error.cause?.message || String(error.cause || ""),
      eventCount,
    });

    if (!res.writableEnded) {
      try {
        if (!emittedRole) {
          writeSse(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
        }

        writeSse(
          res,
          bridge.buildStreamFinalChunk({
            requestModel: requestedModel,
            created,
            completionId,
            finishReason: finalCandidate.finishReason,
            hasToolCalls: sawToolCalls,
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (closeError) {
        logger.error("Failed to close streaming response cleanly", {
          requestId,
          requestedModel,
          vertexModel,
          error: closeError.message,
        });

        if (!res.writableEnded) {
          res.end();
        }
      }
    }
  } finally {
    if (reader && clientClosed) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors from an already-closed stream.
      }
    }
  }
}

async function handleEmbeddings(req, res, { logger, vertexClient, bridge, requestId }) {
  const body = await readJsonBody(req);
  const requests = bridge.toEmbeddingRequests(body);
  const predictionPayloads = [];

  logger.info(`REQ ${requestId} EMBEDDINGS model=${requests[0]?.model || ""} inputs=${requests.length}`);

  for (const request of requests) {
    const response = await vertexClient.predictModel(request.model, request.payload);
    predictionPayloads.push({
      index: request.index,
      payload: await response.json(),
    });
  }

  const payload = bridge.makeEmbeddingResponse({
    model: requests[0]?.model || "",
    encodingFormat: requests[0]?.encodingFormat || "float",
    predictionPayloads,
  });

  logger.info("Completed embeddings request", {
    requestId,
    model: payload.model,
    count: payload.data.length,
  });

  sendJson(res, 200, payload, logger);
}

async function handleImageGenerations(req, res, { logger, vertexClient, bridge, requestId }) {
  const body = await readJsonBody(req);
  const imageRequest = bridge.toImagePayload(body);

  logger.info(`REQ ${requestId} IMAGE model=${imageRequest.model}`);

  const response = await vertexClient.predictModel(imageRequest.model, imageRequest.payload);
  const vertexPayload = await response.json();
  const payload = bridge.makeImageResponse({
    responseFormat: imageRequest.responseFormat,
    payload: vertexPayload,
  });

  logger.info("Completed image generation request", {
    requestId,
    model: imageRequest.model,
    count: payload.data.length,
  });

  sendJson(res, 200, payload, logger);
}

async function handleAudioSpeech(req, res, { logger, vertexClient, bridge, requestId }) {
  const body = await readJsonBody(req);
  const speechRequest = bridge.toSpeechPayload(body);

  logger.info(`REQ ${requestId} SPEECH model=${speechRequest.model} format=${speechRequest.responseFormat}`);

  const response = await vertexClient.synthesizeSpeech(speechRequest.payload);
  const payload = await response.json();
  const audioContent = payload.audioContent || "";

  if (!audioContent) {
    const error = new Error("Text-to-Speech response did not include audioContent.");
    error.statusCode = 502;
    error.type = "server_error";
    throw error;
  }

  const audio = Buffer.from(audioContent, "base64");
  logger.info("Completed speech synthesis request", {
    requestId,
    model: speechRequest.model,
    bytes: audio.length,
  });

  sendBinary(res, 200, audio, bridge.getSpeechContentType(speechRequest.responseFormat), logger);
}

async function handleRerank(req, res, { logger, vertexClient, bridge, requestId }) {
  const body = await readJsonBody(req);
  const rerankRequest = bridge.toRerankPayload(body);

  logger.info(
    `REQ ${requestId} RERANK model=${rerankRequest.model} records=${rerankRequest.payload.records.length}`,
  );

  const response = await vertexClient.rankRecords(rerankRequest.payload);
  const vertexPayload = await response.json();
  const payload = bridge.makeRerankResponse({
    model: rerankRequest.model,
    sourceDocuments: rerankRequest.sourceDocuments,
    idToIndex: rerankRequest.idToIndex,
    returnDocuments: rerankRequest.returnDocuments,
    payload: vertexPayload,
  });

  logger.info("Completed rerank request", {
    requestId,
    model: rerankRequest.model,
    count: payload.results.length,
  });

  sendJson(res, 200, payload, logger);
}

function resolveVertexModel(requestedModel, config) {
  if (!requestedModel) return config.defaultModel;
  return requestedModel;
}

function isAuthorized(req, expectedKey) {
  if (!expectedKey) return true;
  return (req.headers.authorization || "") === `Bearer ${expectedKey}`;
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

function sendJson(res, status, payload, logger) {
  if (res.headersSent || res.writableEnded) {
    logger.error("Attempted to send JSON after response was already started", {
      status,
      payloadType: payload?.error ? "error" : "json",
    });
    return;
  }

  writeCors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendBinary(res, status, payload, contentType, logger) {
  if (res.headersSent || res.writableEnded) {
    logger.error("Attempted to send binary after response was already started", {
      status,
      contentType,
    });
    return;
  }

  writeCors(res);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
  });
  res.end(payload);
}

function sendError(res, status, message, type, logger) {
  sendJson(
    res,
    status,
    {
      error: {
        message,
        type,
      },
    },
    logger,
  );
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Password");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "unknown";
}
