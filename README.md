# Vertex OpenAI Proxy

一个把 `Google Vertex AI / Gemini` 转成 `OpenAI 兼容 /v1` 接口的小型代理。

它的目标很直接：

- 让 `Cherry Studio`、`New API`、各类 `OpenAI SDK` 客户端，直接把 Vertex 当成 OpenAI 风格接口来用
- 保留 `Gemini` 原始模型名
- 支持流式输出
- 可选透传 Gemini 的思考内容

## 功能

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /admin` 本地 Web 控制台
- 支持 `stream: true`
- 支持 Gemini 思考内容透传
- 支持 Bearer Key 校验
- 支持从 Vertex 动态拉取模型列表
- 无第三方 npm 依赖

## 项目结构

- [server.mjs](C:\Users\stran\Desktop\vertex\server.mjs)
  启动入口
- [src/config.mjs](C:\Users\stran\Desktop\vertex\src\config.mjs)
  读取 `.env`、默认值、配置校验
- [src/logger.mjs](C:\Users\stran\Desktop\vertex\src\logger.mjs)
  控制台日志
- [src/vertex-client.mjs](C:\Users\stran\Desktop\vertex\src\vertex-client.mjs)
  Google OAuth、Vertex 请求、模型列表拉取
- [src/openai-bridge.mjs](C:\Users\stran\Desktop\vertex\src\openai-bridge.mjs)
  OpenAI 与 Vertex 消息格式转换
- [src/proxy-server.mjs](C:\Users\stran\Desktop\vertex\src\proxy-server.mjs)
  HTTP 路由与流式转发
- [src/sse.mjs](C:\Users\stran\Desktop\vertex\src\sse.mjs)
  增量 SSE 解析

## 运行要求

- Node.js `20+`
- 一个可访问 `Vertex AI` 的 Google Cloud 项目
- 一份服务账号 JSON，且该账号有调用 Vertex 的权限

## 快速开始

### 1. 准备服务账号

把你的服务账号 JSON 放到项目根目录，并重命名为：

```text
service-account.json
```

也可以不改名，改成在 `.env` 里显式指定路径。

### 2. 创建 `.env`

把 [.env.example](C:\Users\stran\Desktop\vertex\.env.example) 复制成 `.env`。

最小可用配置：

```env
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
VERTEX_PROJECT_ID=your-gcp-project-id
OPENAI_API_KEY=your-local-proxy-key
```

如果你想指定默认模型，可以再加：

```env
VERTEX_MODEL=gemini-3.1-pro-preview
```

### 3. 启动

```powershell
npm start
```

开发时可用：

```powershell
npm run dev
```

启动后默认监听：

```text
http://0.0.0.0:8787
```

Web 控制台入口：

```text
http://127.0.0.1:8787/admin
```

控制台默认密码：

```text
vertex-admin
```

## 配置说明

### 基础网络

- `HOST`
  默认 `0.0.0.0`
  允许局域网、NAT、端口映射后的外部访问
- `PORT`
  默认 `8787`

如果你只想允许本机访问，可以改回：

```env
HOST=127.0.0.1
```

如果你希望通过 NAT、端口映射、内网穿透或局域网 IP 访问，就保持：

```env
HOST=0.0.0.0
```

### 凭证

支持两种方式，任选其一。

方式 1：文件路径

```env
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```

方式 2：直接在环境变量中放完整 JSON

```env
GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account", ...}
```

### Vertex 相关

- `VERTEX_PROJECT_ID`
  你的 GCP 项目 ID
- `VERTEX_LOCATION`
  默认 `global`
- `VERTEX_MODEL`
  客户端未传 `model` 时使用的默认模型

### 代理鉴权

- `OPENAI_API_KEY`
  如果设置了，所有上游客户端必须带：

```http
Authorization: Bearer your-local-proxy-key
```

如果不设置，则代理默认不校验上游 Bearer Key。

### 模型使用

- 客户端直接使用 `/v1/models` 拉到的原始模型 ID
- 不再提供模型别名映射
- `VERTEX_MODEL` 仅作为客户端未传 `model` 时的默认值

### 日志与重试

- `LOG_LEVEL`
  可选：`error`、`info`、`debug`
- `MAX_FETCH_ATTEMPTS`
  Google OAuth 和 Vertex 请求失败时的最大重试次数
- `FETCH_RETRY_DELAY_MS`
  重试间隔毫秒数

### 思考内容

- `INCLUDE_THOUGHTS`
  是否向 Gemini 请求思考内容
- `THOUGHTS_MODE`
  可选：
  - `reasoning_content`
  - `content`
  - `off`
- `THINKING_BUDGET`
  传给 Gemini 的思考预算

推荐理解：

- `reasoning_content`
  以 OpenAI 风格字段输出思考内容
- `content`
  把思考内容包成普通文本输出，更适合兼容性一般的客户端
- `off`
  不输出思考内容

如果某些客户端看不到 reasoning，优先尝试：

```env
THOUGHTS_MODE=content
```

<<<<<<< HEAD
## Cherry Studio 配置

在 Cherry Studio 里这样填：

- Base URL: `http://127.0.0.1:8787/v1`
- API Key: 你在 `.env` 里设置的 `OPENAI_API_KEY`
- Model: 直接填写 Gemini 原始模型名

例如：

```text
gemini-3.1-pro-preview
```

如果 Cherry 不显示思考内容：

```env
THOUGHTS_MODE=content
```

## NAT / 外网访问

如果你希望其他设备通过公网、端口映射、NAT 或局域网访问这台机器，需要满足下面几件事：

1. `.env` 中设置：

```env
HOST=0.0.0.0
PORT=8787
```

2. Windows 防火墙放行 `8787`
3. 路由器、云防火墙或端口映射规则放行 `8787`
4. 强烈建议设置：

```env
OPENAI_API_KEY=your-strong-secret
```

如果你把代理暴露到公网但没有设置 `OPENAI_API_KEY`，别人就可能直接消耗你的 Vertex 配额。

## 接口示例

## Web 控制台

打开：

```text
http://127.0.0.1:8787/admin
```

当前支持：

- 查看当前配置
- 修改常用开关并写回 `.env`
- 拉取并展示当前可用模型
- 导入服务账号 JSON 到 `service-account.json`
- 修改控制台密码

控制台密码默认是：

```text
vertex-admin
```

你可以在控制台页面里直接修改，也可以在 `.env` 中设置：

```env
ADMIN_PASSWORD=your-new-password
```

### 健康检查

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/healthz
```

### 获取模型列表

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/v1/models
```

强制刷新：

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/v1/models?refresh=1
```

=======
>>>>>>> d4b30302d777bc8092b766f9bf40527d1e289c69
### 非流式聊天

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Headers @{ Authorization = "Bearer your-local-proxy-key" } `
  -ContentType "application/json" `
  -Body '{"model":"gemini-3.1-pro-preview","messages":[{"role":"user","content":"Say hello briefly"}]}'
```

### 流式聊天

```powershell
$body = '{"model":"gemini-3.1-pro-preview","stream":true,"messages":[{"role":"user","content":"Say hello briefly"}]}'
Invoke-WebRequest `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Headers @{ Authorization = "Bearer your-local-proxy-key" } `
  -ContentType "application/json" `
  -Body $body | Select-Object -ExpandProperty Content
```






