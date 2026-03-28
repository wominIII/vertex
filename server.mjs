import { networkInterfaces } from "node:os";
import { createConfig, formatStartupSummary } from "./src/config.mjs";
import { createLogger } from "./src/logger.mjs";
import { createVertexClient } from "./src/vertex-client.mjs";
import { createOpenAiBridge } from "./src/openai-bridge.mjs";
import { createProxyServer } from "./src/proxy-server.mjs";

const config = createConfig({ cwd: process.cwd(), env: process.env });
const logger = createLogger(config.logLevel);
const vertexClient = createVertexClient({ config, logger });
const bridge = createOpenAiBridge({ config });
const server = createProxyServer({ config, logger, vertexClient, bridge });

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    logger.error(
      `端口已被占用：${config.host}:${config.port}。请先关闭旧进程，或在 .env 里修改 HOST / PORT。`,
    );
    process.exit(1);
  }

  logger.error("服务启动失败", {
    error: error.message,
    code: error.code || "",
  });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const startup = buildStartupView(config);
  for (const line of startup.lines) {
    logger.info(line);
  }

  logger.debug("Startup configuration", formatStartupSummary(config));

  if (!config.credentials?.client_email || !config.credentials?.private_key) {
    logger.info(`需要配置  请先打开 ${startup.adminUrl} 导入服务账号 JSON`);
  }
});

function buildStartupView(config) {
  const localBaseUrl = `http://127.0.0.1:${config.port}`;
  const localAdminUrl = `${localBaseUrl}/admin`;
  const localApiBase = `${localBaseUrl}/v1`;
  const localHealthUrl = `${localBaseUrl}/healthz`;
  const lanIp = pickLanIp();
  const lanBaseUrl = lanIp ? `http://${lanIp}:${config.port}` : "";
  const lanAdminUrl = lanBaseUrl ? `${lanBaseUrl}/admin` : "";
  const credentialsReady = Boolean(config.credentials?.client_email && config.credentials?.private_key);

  return {
    adminUrl: localAdminUrl,
    lines: [
      "============================================================",
      "VERTEX OPENAI PROXY  启动成功",
      "============================================================",
      `状态          ${credentialsReady ? "已就绪" : "等待导入凭证"}`,
      `管理后台      ${localAdminUrl}`,
      `接口地址      ${localApiBase}`,
      `健康检查      ${localHealthUrl}`,
      ...(lanAdminUrl ? [`局域网后台    ${lanAdminUrl}`] : []),
      `监听地址      http://${config.host}:${config.port}`,
      `默认模型      ${config.defaultModel}`,
      `思考内容      ${config.includeThoughts ? "开启" : "关闭"}`,
      `流式传输      ${config.enableStreaming ? "开启" : "关闭"}`,
      "============================================================",
    ],
  };
}

function pickLanIp() {
  const nets = networkInterfaces();
  for (const group of Object.values(nets)) {
    for (const info of group || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      return info.address;
    }
  }

  return "";
}
