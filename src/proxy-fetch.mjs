import http from "node:http";
import tls from "node:tls";
import { Readable, Transform } from "node:stream";

export function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

export async function proxyFetch(url, options = {}, proxyUrl) {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxyUrl) return fetch(url, options);

  const proxy = new URL(normalizedProxyUrl);
  if (proxy.protocol !== "http:") {
    throw new Error(`Unsupported outbound proxy protocol: ${proxy.protocol}. Use http://host:port.`);
  }

  const target = new URL(url);
  if (target.protocol === "https:") {
    return fetchHttpsViaHttpProxy(target, options, proxy);
  }
  if (target.protocol === "http:") {
    return fetchHttpViaHttpProxy(target, options, proxy);
  }

  throw new Error(`Unsupported request protocol through proxy: ${target.protocol}`);
}

function fetchHttpsViaHttpProxy(target, options, proxy) {
  return new Promise((resolve, reject) => {
    const proxyRequest = http.request(
      {
        host: proxy.hostname,
        port: proxy.port || 80,
        method: "CONNECT",
        path: `${target.hostname}:${target.port || 443}`,
        headers: {
          Host: `${target.hostname}:${target.port || 443}`,
          ...proxyAuthHeader(proxy),
        },
      },
    );

    proxyRequest.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Outbound proxy CONNECT failed with status ${response.statusCode}`));
        return;
      }

      const secureSocket = tls.connect(
        {
          socket,
          servername: target.hostname,
        },
        () => {
          sendHttpsRequestOverTunnel(target, options, secureSocket, resolve, reject);
        },
      );

      secureSocket.once("error", reject);
    });

    proxyRequest.once("error", reject);
    proxyRequest.end();
  });
}

function fetchHttpViaHttpProxy(target, options, proxy) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: proxy.port || 80,
        method: normalizeMethod(options.method),
        path: target.href,
        headers: {
          ...normalizeHeaders(options.headers),
          Host: target.host,
          ...proxyAuthHeader(proxy),
        },
        agent: false,
      },
      (response) => resolve(toFetchResponse(response)),
    );

    request.once("error", reject);
    writeRequestBody(request, options.body);
  });
}

function toFetchResponse(response) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }

  const status = response.statusCode || 0;
  const body = status === 204 || status === 304 ? null : Readable.toWeb(response);
  return new Response(body, {
    status,
    statusText: response.statusMessage || "",
    headers,
  });
}

function sendHttpsRequestOverTunnel(target, options, socket, resolve, reject) {
  const body = normalizeBody(options.body);
  const headers = {
    ...normalizeHeaders(options.headers),
    Host: target.host,
    Connection: "close",
    "Accept-Encoding": "identity",
  };
  if (body !== null && !hasHeader(headers, "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  const requestHead = [
    `${normalizeMethod(options.method)} ${target.pathname}${target.search} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

  socket.write(requestHead);
  if (body !== null) socket.write(body);

  readHttpResponseFromSocket(socket).then(resolve, reject);
}

function readHttpResponseFromSocket(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);

    function onData(chunk) {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        socket.off("data", onData);
        socket.off("error", reject);

        const rawHeaders = buffered.slice(0, headerEnd).toString("latin1");
        const remaining = buffered.slice(headerEnd + 4);
        const { status, statusText, headers } = parseResponseHead(rawHeaders);
        if (remaining.length) socket.unshift(remaining);

        const body =
          status === 204 || status === 304
            ? null
            : Readable.toWeb(createDecodedBodyStream(socket, headers));

        resolve(new Response(body, { status, statusText, headers }));
      } catch (error) {
        reject(error);
      }
    }

    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function parseResponseHead(rawHeaders) {
  const lines = rawHeaders.split("\r\n");
  const statusLine = lines.shift() || "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) {
    throw new Error(`Invalid proxy response from upstream: ${statusLine}`);
  }

  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    headers.append(name, value);
  }

  return {
    status: Number(match[1]),
    statusText: match[2] || "",
    headers,
  };
}

function createDecodedBodyStream(socket, headers) {
  const transferEncoding = headers.get("transfer-encoding") || "";
  if (/\bchunked\b/i.test(transferEncoding)) {
    const decoder = new ChunkedDecoder();
    socket.pipe(decoder);
    return decoder;
  }
  return socket;
}

function writeRequestBody(request, body) {
  const normalizedBody = normalizeBody(body);
  if (normalizedBody !== null) {
    request.write(normalizedBody);
  }
  request.end();
}

function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body);
  return String(body);
}

function hasHeader(headers, name) {
  const needle = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function normalizeMethod(method) {
  return String(method || "GET").toUpperCase();
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}

class ChunkedDecoder extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.expectingSize = true;
    this.remaining = 0;
    this.done = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this.done) {
      callback();
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      this.drainBuffer();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  drainBuffer() {
    while (!this.done) {
      if (this.expectingSize) {
        const lineEnd = this.buffer.indexOf("\r\n");
        if (lineEnd < 0) return;

        const line = this.buffer.slice(0, lineEnd).toString("ascii");
        this.buffer = this.buffer.slice(lineEnd + 2);
        const sizeText = line.split(";", 1)[0].trim();
        this.remaining = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(this.remaining)) {
          throw new Error(`Invalid chunk size from upstream: ${line}`);
        }
        if (this.remaining === 0) {
          this.done = true;
          this.push(null);
          return;
        }
        this.expectingSize = false;
      }

      if (this.buffer.length < this.remaining + 2) return;

      this.push(this.buffer.slice(0, this.remaining));
      this.buffer = this.buffer.slice(this.remaining + 2);
      this.remaining = 0;
      this.expectingSize = true;
    }
  }
}
