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

server.listen(config.port, config.host, () => {
  logger.info(
    `Vertex OpenAI proxy listening on http://${config.host}:${config.port} using default model ${config.defaultModel}`,
  );
  logger.info("Startup configuration", formatStartupSummary(config));
});
