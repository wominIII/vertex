export function createSseParser(onEvent) {
  let buffer = "";
  let dataLines = [];

  function push(chunk) {
    buffer += chunk;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(rawLine);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  function flush() {
    if (buffer.length) {
      processLine(buffer);
      buffer = "";
    }
    finalizeEvent();
  }

  function processLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      finalizeEvent();
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  function finalizeEvent() {
    if (!dataLines.length) return;

    const payload = dataLines.join("\n").trim();
    dataLines = [];

    if (!payload || payload === "[DONE]") return;
    onEvent(JSON.parse(payload));
  }

  return { push, flush };
}
