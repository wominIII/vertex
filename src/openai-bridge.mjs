import { randomUUID } from "node:crypto";

export function createOpenAiBridge({ config }) {
  const assistantPartsCache = new Map();

  return {
    toVertexPayload,
    makeChatCompletion,
    toEmbeddingRequests,
    makeEmbeddingResponse,
    toImagePayload,
    makeImageResponse,
    toSpeechPayload,
    getSpeechContentType,
    toRerankPayload,
    makeRerankResponse,
    splitVertexParts,
    rememberAssistantParts,
    buildStreamingChunks,
    buildStreamFinalChunk,
  };

  async function toVertexPayload(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemTexts = [];
    const contents = [];
    const toolCallNames = new Map();

    for (const message of messages) {
      const role = message?.role;

      if (role === "system") {
        const text = normalizeMessageText(message?.content);
        if (text) systemTexts.push(text);
        continue;
      }

      if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "function") {
        continue;
      }

      let parts = [];
      if (role === "assistant") {
        parts = await resolveAssistantParts(message);
        rememberOpenAiToolCallNames(message?.tool_calls, toolCallNames);
      } else if (role === "tool" || role === "function") {
        parts = [createFunctionResponsePart(message, toolCallNames)];
      } else {
        parts = await extractOpenAiParts(message?.content);
      }

      if (!parts.length) continue;

      contents.push({
        role: role === "assistant" ? "model" : "user",
        parts,
      });
    }

    if (!contents.length) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    const generationConfig = {};
    const temperature =
      typeof body.temperature === "number" ? body.temperature : config.defaultTemperature;
    const topP = typeof body.top_p === "number" ? body.top_p : config.defaultTopP;
    const topK = typeof body.top_k === "number" ? body.top_k : config.defaultTopK;
    const maxOutputTokens =
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : config.defaultMaxOutputTokens;

    if (typeof temperature === "number") generationConfig.temperature = temperature;
    if (typeof topP === "number") generationConfig.topP = topP;
    if (typeof topK === "number") generationConfig.topK = topK;
    if (typeof maxOutputTokens === "number") generationConfig.maxOutputTokens = maxOutputTokens;
    if (Array.isArray(body.stop) && body.stop.length) generationConfig.stopSequences = body.stop;
    if (config.includeThoughts) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: config.thinkingBudget,
      };
    }

    const tools = convertOpenAiTools(body.tools, body.functions);
    const toolConfig = convertToolChoice(body.tool_choice ?? body.function_call, tools);

    return {
      contents,
      ...(systemTexts.length
        ? {
            systemInstruction: {
              parts: [{ text: systemTexts.join("\n\n") }],
            },
          }
        : {}),
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      ...(toolConfig ? { toolConfig } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
  }

  function makeChatCompletion({ requestModel, vertexModel, candidate, usage }) {
    const text = extractVisibleText(candidate);
    const reasoning = extractThoughtText(candidate);
    const toolCalls = extractToolCalls(candidate);
    const message = {
      role: "assistant",
      content: toolCalls.length ? null : formatFinalContent(text, reasoning),
    };

    if (config.thoughtsMode === "reasoning_content" && reasoning) {
      message.reasoning_content = reasoning;
    }
    if (toolCalls.length) {
      message.tool_calls = toolCalls;
    }

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestModel || vertexModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokenCount ?? 0,
        completion_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        total_tokens: usage?.totalTokenCount ?? 0,
      },
      system_fingerprint: vertexModel,
    };
  }

  function buildStreamingChunks({ requestModel, candidate, created, completionId, emitRole }) {
    const chunks = [];
    const { thoughtParts, answerParts } = splitVertexParts(candidate?.content?.parts || []);

    if (emitRole) {
      chunks.push({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
    }

    if (config.thoughtsMode !== "off") {
      for (const part of thoughtParts) {
        if (!part.text) continue;
        const delta = formatThoughtDelta(part.text);
        if (!delta) continue;
        chunks.push({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: requestModel,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      }
    }

    let toolCallIndex = 0;
    for (const part of answerParts) {
      if (part.functionCall) {
        chunks.push({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: requestModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [createStreamingToolCallDelta(part.functionCall, toolCallIndex)],
              },
              finish_reason: null,
            },
          ],
        });
        toolCallIndex += 1;
        continue;
      }

      if (!part.text) continue;
      chunks.push({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: requestModel,
        choices: [
          {
            index: 0,
            delta: { content: part.text },
            finish_reason: null,
          },
        ],
      });
    }

    return chunks;
  }

  function buildStreamFinalChunk({ requestModel, created, completionId, finishReason, hasToolCalls }) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: requestModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mapFinishReason(finishReason, hasToolCalls),
        },
      ],
    };
  }

  function toEmbeddingRequests(body) {
    const model = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : config.defaultEmbeddingModel;
    const inputs = normalizeEmbeddingInputs(body.input);
    const encodingFormat = body.encoding_format === "base64" ? "base64" : "float";

    if (!inputs.length) {
      throw createInvalidRequestError("Embedding input is required.");
    }

    return inputs.map((input, index) => {
      const instance = { content: input };
      if (typeof body.task_type === "string" && body.task_type.trim()) {
        instance.task_type = body.task_type.trim();
      }
      if (typeof body.title === "string" && body.title.trim()) {
        instance.title = body.title.trim();
      }

      const parameters = {};
      if (body.auto_truncate !== undefined) {
        parameters.autoTruncate = Boolean(body.auto_truncate);
      }
      if (body.dimensions !== undefined) {
        const dimensions = Number(body.dimensions);
        if (Number.isFinite(dimensions) && dimensions > 0) {
          parameters.outputDimensionality = Math.floor(dimensions);
        }
      }

      return {
        index,
        model,
        encodingFormat,
        payload: {
          instances: [instance],
          ...(Object.keys(parameters).length ? { parameters } : {}),
        },
      };
    });
  }

  function makeEmbeddingResponse({ model, encodingFormat, predictionPayloads }) {
    let totalTokens = 0;
    const data = [];

    for (const item of predictionPayloads) {
      const prediction = item.payload?.predictions?.[0] || {};
      const values = extractEmbeddingValues(prediction);
      const tokenCount = Number(prediction?.embeddings?.statistics?.token_count || 0);
      totalTokens += Number.isFinite(tokenCount) ? tokenCount : 0;

      data.push({
        object: "embedding",
        index: item.index,
        embedding: encodingFormat === "base64" ? floatArrayToBase64(values) : values,
      });
    }

    data.sort((a, b) => a.index - b.index);

    return {
      object: "list",
      data,
      model,
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
      },
    };
  }

  function toImagePayload(body) {
    const model = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : config.defaultImageModel;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";

    if (!prompt.trim()) {
      throw createInvalidRequestError("Image generation prompt is required.");
    }

    const outputMimeType = mapImageMimeType(body.output_format || body.response_format);
    const parameters = {
      sampleCount: clampInteger(body.n, 1, 4, 1),
    };
    const aspectRatio = body.aspect_ratio || sizeToAspectRatio(body.size);
    if (aspectRatio) parameters.aspectRatio = aspectRatio;
    if (body.enhance_prompt !== undefined) parameters.enhancePrompt = Boolean(body.enhance_prompt);
    if (body.add_watermark !== undefined) parameters.addWatermark = Boolean(body.add_watermark);
    if (body.include_rai_reason !== undefined) parameters.includeRaiReason = Boolean(body.include_rai_reason);
    if (body.include_safety_attributes !== undefined) {
      parameters.includeSafetyAttributes = Boolean(body.include_safety_attributes);
    }
    if (typeof body.person_generation === "string") parameters.personGeneration = body.person_generation;
    if (typeof body.safety_setting === "string") parameters.safetySetting = body.safety_setting;
    if (body.seed !== undefined && Number.isFinite(Number(body.seed))) {
      parameters.seed = Number(body.seed);
    }
    if (outputMimeType) {
      parameters.outputOptions = { mimeType: outputMimeType };
    }

    return {
      model,
      responseFormat: body.response_format === "url" ? "url" : "b64_json",
      payload: {
        instances: [{ prompt }],
        parameters,
      },
    };
  }

  function makeImageResponse({ responseFormat, payload }) {
    const predictions = Array.isArray(payload?.predictions) ? payload.predictions : [];

    return {
      created: Math.floor(Date.now() / 1000),
      data: predictions.map((prediction) => {
        const mimeType = prediction.mimeType || "image/png";
        const b64 = prediction.bytesBase64Encoded || prediction.image || "";
        const item = responseFormat === "url"
          ? { url: `data:${mimeType};base64,${b64}` }
          : { b64_json: b64 };

        if (prediction.prompt) {
          item.revised_prompt = prediction.prompt;
        }

        return item;
      }),
    };
  }

  function toSpeechPayload(body) {
    const input = typeof body.input === "string" ? body.input : "";
    if (!input.trim()) {
      throw createInvalidRequestError("Speech input is required.");
    }

    const requestedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "";
    const model = isOpenAiTtsModel(requestedModel) || !requestedModel
      ? config.defaultTtsModel
      : requestedModel;
    const responseFormat = normalizeSpeechFormat(body.response_format);
    const voiceName = mapSpeechVoice(body.voice);
    const languageCode =
      (typeof body.language === "string" && body.language.trim()) ||
      config.ttsLanguageCode ||
      inferSpeechLanguage(input);
    const audioConfig = {
      audioEncoding: mapSpeechEncoding(responseFormat),
    };

    if (body.speed !== undefined && Number.isFinite(Number(body.speed))) {
      audioConfig.speakingRate = Math.min(4, Math.max(0.25, Number(body.speed)));
    }
    if (body.sample_rate_hertz !== undefined && Number.isFinite(Number(body.sample_rate_hertz))) {
      audioConfig.sampleRateHertz = Math.floor(Number(body.sample_rate_hertz));
    }

    const speechInput = { text: input };
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      speechInput.prompt = body.instructions.trim();
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      speechInput.prompt = body.prompt.trim();
    }

    const voice = {
      languageCode,
      name: voiceName,
    };

    if (model) {
      voice.modelName = model;
    }

    return {
      model,
      responseFormat,
      payload: {
        input: speechInput,
        voice,
        audioConfig,
      },
    };
  }

  function getSpeechContentType(responseFormat) {
    switch (responseFormat) {
      case "mp3":
        return "audio/mpeg";
      case "opus":
        return "audio/ogg";
      case "pcm":
        return "audio/L16";
      case "wav":
      default:
        return "audio/wav";
    }
  }

  function toRerankPayload(body) {
    const query = typeof body.query === "string" ? body.query : "";
    const sourceDocuments = Array.isArray(body.documents)
      ? body.documents
      : Array.isArray(body.records)
        ? body.records
        : [];

    if (!query.trim()) {
      throw createInvalidRequestError("Rerank query is required.");
    }
    if (!sourceDocuments.length) {
      throw createInvalidRequestError("Rerank documents are required.");
    }

    const model = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : config.defaultRerankModel;
    const records = sourceDocuments.map((document, index) => documentToRankRecord(document, index));
    const payload = {
      model,
      query,
      records,
    };
    const topN = body.top_n ?? body.topN;
    if (topN !== undefined && Number.isFinite(Number(topN))) {
      payload.topN = Math.max(1, Math.floor(Number(topN)));
    }

    return {
      model,
      returnDocuments: body.return_documents !== false,
      sourceDocuments,
      idToIndex: new Map(records.map((record, index) => [record.id, index])),
      payload,
    };
  }

  function makeRerankResponse({ model, sourceDocuments, idToIndex, returnDocuments, payload }) {
    const records = Array.isArray(payload?.records) ? payload.records : [];

    return {
      id: `rerank-${randomUUID()}`,
      object: "list",
      model,
      results: records.map((record) => {
        const index = idToIndex.has(record.id) ? idToIndex.get(record.id) : Number(record.id);
        const item = {
          index: Number.isFinite(index) ? index : 0,
          relevance_score: Number(record.score || 0),
        };

        if (returnDocuments) {
          item.document = normalizeReturnedDocument(sourceDocuments[item.index], record);
        }

        return item;
      }),
      meta: {
        api_version: {
          version: "vertex-ranking-v1",
        },
      },
    };
  }

  function splitVertexParts(parts) {
    const thoughtParts = [];
    const answerParts = [];

    for (const part of parts || []) {
      if (!part || typeof part !== "object") continue;
      if (part.thought) {
        thoughtParts.push(part);
      } else {
        answerParts.push(part);
      }
    }

    return { thoughtParts, answerParts };
  }

  function rememberAssistantParts(parts) {
    const visibleText = parts
      .filter((part) => part && typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("");

    if (!visibleText) return;

    assistantPartsCache.set(visibleText, structuredClone(parts));
    if (assistantPartsCache.size > 200) {
      const oldestKey = assistantPartsCache.keys().next().value;
      assistantPartsCache.delete(oldestKey);
    }
  }

  async function resolveAssistantParts(message) {
    const content = message?.content;
    const visibleText = normalizeMessageText(content);
    const cachedParts = assistantPartsCache.get(visibleText);
    if (cachedParts) return cachedParts;

    const parts = await extractOpenAiParts(content);
    for (const toolCall of message?.tool_calls || []) {
      const part = createFunctionCallPart(toolCall);
      if (part) parts.push(part);
    }
    if (message?.function_call) {
      const part = createFunctionCallPart({
        function: {
          name: message.function_call.name,
          arguments: message.function_call.arguments,
        },
      });
      if (part) parts.push(part);
    }

    return parts;
  }

  function extractVisibleText(candidate) {
    return (candidate?.content?.parts || [])
      .filter((part) => !part?.thought && !part?.functionCall)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  function extractToolCalls(candidate) {
    return (candidate?.content?.parts || [])
      .filter((part) => part?.functionCall)
      .map((part, index) => createOpenAiToolCall(part.functionCall, index));
  }

  function extractThoughtText(candidate) {
    return (candidate?.content?.parts || [])
      .filter((part) => part?.thought)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  async function extractOpenAiParts(content) {
    if (typeof content === "string") {
      return [{ text: content }];
    }

    if (Array.isArray(content)) {
      const parts = [];

      for (const item of content) {
        const part = await convertContentItemToVertexPart(item);
        if (part) parts.push(part);
      }

      return parts;
    }

    return [];
  }

  function normalizeMessageText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
    }
    return "";
  }

  function formatThoughtDelta(text) {
    if (config.thoughtsMode === "reasoning_content") {
      return { reasoning_content: text };
    }

    if (config.thoughtsMode === "content") {
      return { content: `<think>\n${text}\n</think>\n` };
    }

    return null;
  }

  function formatFinalContent(text, reasoning) {
    if (config.thoughtsMode === "content" && reasoning) {
      return `<think>\n${reasoning}\n</think>\n\n${text}`;
    }
    return text;
  }

  async function convertContentItemToVertexPart(item) {
    if (!item || typeof item !== "object") return null;

    switch (item.type) {
      case "text":
      case "input_text":
        return typeof item.text === "string" ? { text: item.text } : null;
      case "image_url":
      case "input_image":
      case "image":
        return createImagePart(item);
      default:
        return null;
    }
  }

  async function createImagePart(item) {
    const imageRef = item.image_url ?? item.image ?? item.input_image ?? item.url;
    const imageUrl =
      typeof imageRef === "string"
        ? imageRef
        : typeof imageRef?.url === "string"
          ? imageRef.url
          : typeof imageRef?.image_url === "string"
            ? imageRef.image_url
            : typeof imageRef?.uri === "string"
              ? imageRef.uri
              : "";

    if (!imageUrl) {
      throw createInvalidRequestError("Image content item is missing a usable image URL.");
    }

    if (imageUrl.startsWith("data:")) {
      return parseDataUrlImagePart(imageUrl);
    }

    return fetchRemoteImagePart(imageUrl, item);
  }

  function parseDataUrlImagePart(imageUrl) {
    const match = imageUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/i);
    if (!match) {
      throw createInvalidRequestError("Unsupported data URL image format.");
    }

    const mimeType = normalizeMimeType(match[1], "");
    const isBase64 = Boolean(match[2]);
    const rawData = match[3] || "";
    const data = isBase64
      ? rawData.replace(/\s+/g, "")
      : Buffer.from(decodeURIComponent(rawData), "utf8").toString("base64");

    return {
      inlineData: {
        mimeType,
        data,
      },
    };
  }

  async function fetchRemoteImagePart(imageUrl, item) {
    let response;
    try {
      response = await fetch(imageUrl);
    } catch (error) {
      throw createInvalidRequestError(
        `Failed to download image input: ${error.message || "unknown fetch error"}`,
      );
    }

    if (!response.ok) {
      throw createInvalidRequestError(
        `Failed to download image input: upstream returned ${response.status}.`,
      );
    }

    const mimeType = normalizeMimeType(
      item?.mime_type || item?.mimeType || response.headers.get("content-type"),
      imageUrl,
    );
    const bytes = Buffer.from(await response.arrayBuffer());

    return {
      inlineData: {
        mimeType,
        data: bytes.toString("base64"),
      },
    };
  }
}

function convertOpenAiTools(tools, functions) {
  const normalizedTools = Array.isArray(tools)
    ? tools
    : Array.isArray(functions)
      ? functions.map((fn) => ({ type: "function", function: fn }))
      : [];

  return normalizedTools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .slice(0, 128)
    .map((tool) => {
      const declaration = {
        name: tool.function.name,
      };
      if (typeof tool.function.description === "string" && tool.function.description.trim()) {
        declaration.description = tool.function.description;
      }
      if (tool.function.parameters && typeof tool.function.parameters === "object") {
        declaration.parameters = convertJsonSchemaToVertexSchema(tool.function.parameters);
      }
      return declaration;
    });
}

function convertToolChoice(toolChoice, tools) {
  if (!toolChoice || !tools.length) return null;
  if (toolChoice === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }

  if (typeof toolChoice === "string") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice],
      },
    };
  }

  const name = toolChoice?.function?.name;
  if (toolChoice?.type === "function" && typeof name === "string" && name.trim()) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [name.trim()],
      },
    };
  }

  return null;
}

function convertJsonSchemaToVertexSchema(schema) {
  if (!schema || typeof schema !== "object") return {};

  const converted = {};
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (typeof type === "string") {
    converted.type = type.toUpperCase();
  }
  if (typeof schema.description === "string") converted.description = schema.description;
  if (typeof schema.format === "string") converted.format = schema.format;
  if (Array.isArray(schema.enum)) converted.enum = schema.enum.map((item) => String(item));
  if (Array.isArray(schema.required)) converted.required = schema.required;
  if (schema.nullable !== undefined) converted.nullable = Boolean(schema.nullable);
  if (Array.isArray(schema.type) && schema.type.includes("null")) converted.nullable = true;
  if (schema.items && typeof schema.items === "object") {
    converted.items = convertJsonSchemaToVertexSchema(schema.items);
  }
  if (schema.properties && typeof schema.properties === "object") {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        convertJsonSchemaToVertexSchema(value),
      ]),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    converted.anyOf = schema.anyOf.map((item) => convertJsonSchemaToVertexSchema(item));
  }

  return converted;
}

function createFunctionCallPart(toolCall) {
  const name = toolCall?.function?.name;
  if (typeof name !== "string" || !name.trim()) return null;

  return {
    functionCall: {
      name: name.trim(),
      args: parseFunctionArguments(toolCall.function.arguments),
    },
  };
}

function createFunctionResponsePart(message, toolCallNames) {
  const toolCallId = String(message?.tool_call_id || "");
  const name =
    (typeof message?.name === "string" && message.name.trim()) ||
    toolCallNames.get(toolCallId) ||
    toolCallId ||
    "tool";

  return {
    functionResponse: {
      name,
      response: normalizeFunctionResponse(message?.content),
    },
  };
}

function rememberOpenAiToolCallNames(toolCalls, toolCallNames) {
  for (const toolCall of toolCalls || []) {
    const id = toolCall?.id;
    const name = toolCall?.function?.name;
    if (typeof id === "string" && id && typeof name === "string" && name) {
      toolCallNames.set(id, name);
    }
  }
}

function createOpenAiToolCall(functionCall, index) {
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: functionCall?.name || `function_${index}`,
      arguments: JSON.stringify(functionCall?.args || {}),
    },
  };
}

function createStreamingToolCallDelta(functionCall, index) {
  return {
    index,
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: functionCall?.name || "function",
      arguments: JSON.stringify(functionCall?.args || {}),
    },
  };
}

function parseFunctionArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { arguments: value };
  }
}

function normalizeFunctionResponse(content) {
  const text = normalizeFunctionResponseText(content);
  if (!text) return { output: "" };

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { output: parsed };
  } catch {
    return { output: text };
  }
}

function normalizeFunctionResponseText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function mapFinishReason(reason, hasToolCalls = false) {
  if (hasToolCalls) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content_filter";
    default:
      return "stop";
  }
}

function normalizeEmbeddingInputs(input) {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => {
      if (typeof item === "string") return item;
      if (Array.isArray(item)) return item.join(" ");
      if (item && typeof item === "object") {
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
      }
      return "";
    })
    .filter((item) => item.length);
}

function extractEmbeddingValues(prediction) {
  const values =
    prediction?.embeddings?.values ??
    prediction?.embedding?.values ??
    prediction?.values ??
    prediction?.embedding ??
    [];

  return Array.isArray(values) ? values.map((value) => Number(value)) : [];
}

function floatArrayToBase64(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    buffer.writeFloatLE(Number(value) || 0, index * 4);
  });
  return buffer.toString("base64");
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sizeToAspectRatio(size) {
  if (typeof size !== "string") return "";
  const match = size.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return "";

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "";

  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.05) return "1:1";
  if (Math.abs(ratio - 4 / 3) < 0.08) return "4:3";
  if (Math.abs(ratio - 3 / 4) < 0.08) return "3:4";
  if (Math.abs(ratio - 16 / 9) < 0.08) return "16:9";
  if (Math.abs(ratio - 9 / 16) < 0.08) return "9:16";
  return "";
}

function mapImageMimeType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  if (normalized === "png" || normalized === "b64_json" || normalized === "url" || !normalized) {
    return "image/png";
  }
  if (normalized.startsWith("image/")) return normalized;
  return "image/png";
}

function normalizeSpeechFormat(value) {
  const normalized = String(value || "mp3").trim().toLowerCase();
  if (["mp3", "opus", "wav", "pcm"].includes(normalized)) return normalized;
  return "mp3";
}

function mapSpeechEncoding(format) {
  switch (format) {
    case "opus":
      return "OGG_OPUS";
    case "pcm":
      return "PCM";
    case "wav":
      return "LINEAR16";
    case "mp3":
    default:
      return "MP3";
  }
}

function isOpenAiTtsModel(model) {
  return ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"].includes(String(model || "").toLowerCase());
}

function mapSpeechVoice(voice) {
  const raw = String(voice || "alloy").trim();
  const aliases = {
    alloy: "Kore",
    echo: "Charon",
    fable: "Aoede",
    onyx: "Orus",
    nova: "Leda",
    shimmer: "Zephyr",
  };

  return aliases[raw.toLowerCase()] || raw || "Kore";
}

function inferSpeechLanguage(input) {
  if (/[\u4e00-\u9fff]/.test(input)) return "cmn-CN";
  if (/[\u3040-\u30ff]/.test(input)) return "ja-JP";
  if (/[\uac00-\ud7af]/.test(input)) return "ko-KR";
  return "en-US";
}

function documentToRankRecord(document, index) {
  if (typeof document === "string") {
    return {
      id: String(index),
      content: document,
    };
  }

  const id = document?.id !== undefined ? String(document.id) : String(index);
  const title = document?.title !== undefined ? String(document.title) : "";
  const content = String(document?.content ?? document?.text ?? document?.document ?? "");
  const record = { id };
  if (title) record.title = title;
  if (content) record.content = content;
  return record;
}

function normalizeReturnedDocument(sourceDocument, rankedRecord) {
  if (typeof sourceDocument === "string") {
    return { text: sourceDocument };
  }

  if (sourceDocument && typeof sourceDocument === "object") {
    return sourceDocument;
  }

  return {
    title: rankedRecord.title || "",
    text: rankedRecord.content || "",
  };
}

function normalizeMimeType(mimeType, sourceUrl) {
  const normalized = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (normalized) return normalized;

  const pathname = sourceUrl
    ? (() => {
        try {
          return new URL(sourceUrl).pathname.toLowerCase();
        } catch {
          return String(sourceUrl).toLowerCase();
        }
      })()
    : "";

  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".bmp")) return "image/bmp";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".heic")) return "image/heic";
  if (pathname.endsWith(".heif")) return "image/heif";

  throw createInvalidRequestError("Could not determine the image MIME type for this request.");
}

function createInvalidRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.type = "invalid_request_error";
  return error;
}
