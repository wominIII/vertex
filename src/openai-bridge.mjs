import { randomUUID } from "node:crypto";

export function createOpenAiBridge({ config }) {
  const assistantPartsCache = new Map();

  return {
    toVertexPayload,
    makeChatCompletion,
    splitVertexParts,
    rememberAssistantParts,
    buildStreamingChunks,
    buildStreamFinalChunk,
  };

  function toVertexPayload(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemTexts = [];
    const contents = [];

    for (const message of messages) {
      const role = message?.role;

      if (role === "system") {
        const text = normalizeMessageText(message?.content);
        if (text) systemTexts.push(text);
        continue;
      }

      if (role !== "user" && role !== "assistant") continue;

      const parts =
        role === "assistant"
          ? resolveAssistantParts(message?.content)
          : extractOpenAiParts(message?.content);

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
    if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
    if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
    if (typeof body.max_tokens === "number") generationConfig.maxOutputTokens = body.max_tokens;
    if (Array.isArray(body.stop) && body.stop.length) generationConfig.stopSequences = body.stop;
    if (config.includeThoughts) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: config.thinkingBudget,
      };
    }

    return {
      contents,
      ...(systemTexts.length
        ? {
            systemInstruction: {
              parts: [{ text: systemTexts.join("\n\n") }],
            },
          }
        : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
  }

  function makeChatCompletion({ requestModel, vertexModel, candidate, usage }) {
    const text = extractVisibleText(candidate);
    const reasoning = extractThoughtText(candidate);
    const message = {
      role: "assistant",
      content: formatFinalContent(text, reasoning),
    };

    if (config.thoughtsMode === "reasoning_content" && reasoning) {
      message.reasoning_content = reasoning;
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
          finish_reason: mapFinishReason(candidate?.finishReason),
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

    for (const part of answerParts) {
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

  function buildStreamFinalChunk({ requestModel, created, completionId, finishReason }) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: requestModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mapFinishReason(finishReason),
        },
      ],
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

  function resolveAssistantParts(content) {
    const visibleText = normalizeMessageText(content);
    return assistantPartsCache.get(visibleText) || extractOpenAiParts(content);
  }

  function extractVisibleText(candidate) {
    return (candidate?.content?.parts || [])
      .filter((part) => !part?.thought)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  function extractThoughtText(candidate) {
    return (candidate?.content?.parts || [])
      .filter((part) => part?.thought)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  function extractOpenAiParts(content) {
    if (typeof content === "string") {
      return [{ text: content }];
    }

    if (Array.isArray(content)) {
      return content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => ({ text: item.text }));
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
}

function mapFinishReason(reason) {
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
