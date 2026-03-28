# Vertex OpenAI Proxy
一个把 `Google Vertex AI / Gemini` 转成 `OpenAI 兼容 /v1` 接口的轻量代理。
## 界面预览

![管理控制台截图](./docs/preview.png)

它适合这些场景：

- 想通过本地或局域网部署一个可配置的 Vertex 网关
- 想用 Web 控制台导入服务账号 JSON、查看模型、修改常用配置

## 功能特性

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /admin` 管理控制台
- 支持流式和非流式响应
- 支持 Gemini 思考内容透传
- 支持代理 Bearer Key 校验
- 支持从 Vertex 动态拉取可用模型
- 无第三方 npm 依赖
- 没有服务账号 JSON 时也可以先启动，再在 Web 控制台中导入

## 运行要求

- Node.js `20+`
- 一个可访问 `Vertex AI` 的 Google Cloud 项目
- 一份具有 Vertex 调用权限的服务账号 JSON

## 目录说明

- `server.mjs`
  启动入口
- `src/config.mjs`
  配置读取、默认值、环境变量处理
- `src/logger.mjs`
  控制台日志
- `src/vertex-client.mjs`
  Google OAuth、Vertex 请求、模型列表拉取
- `src/openai-bridge.mjs`
  OpenAI 与 Vertex 请求格式转换
- `src/proxy-server.mjs`
  HTTP 路由和请求处理
- `src/sse.mjs`
  SSE 流解析
- `src/admin-ui.mjs`
  管理控制台 API
- `ui/`
  管理控制台前端文件
- `run.bat`
  Windows 一键启动脚本

## 快速开始

### 1. 克隆项目

```powershell
git clone https://github.com/wominIII/vertex.git
cd vertex
```

### 2. 准备配置文件

把 `.env.example` 复制为 `.env`：

```powershell
Copy-Item .env.example .env
```

最小推荐配置：

```env
HOST=0.0.0.0
PORT=8787
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
VERTEX_PROJECT_ID=your-gcp-project-id
VERTEX_LOCATION=global
OPENAI_API_KEY=your-local-proxy-key
ADMIN_PASSWORD=vertex-admin
```

### 3. 启动服务

Windows 推荐直接运行：

```bat
run.bat
```

也可以使用：

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

### 4. 打开管理控制台

启动后访问：

```text
http://127.0.0.1:8787/admin
```

默认控制台密码：

```text
vertex-admin
```

如果你还没有准备好服务账号 JSON，也没关系。现在可以先启动服务，再到控制台中导入服务账号。

## 导入服务账号 JSON

控制台支持直接粘贴并导入服务账号 JSON。

导入后会：

- 保存为项目根目录的 `service-account.json`
- 自动更新 `.env`
- 使用 JSON 中的 `project_id`

如果你不想用默认文件名，也可以自己手动放文件，再在 `.env` 中修改：

```env
GOOGLE_APPLICATION_CREDENTIALS=./your-service-account.json
```

## 管理控制台

控制台地址：

```text
http://127.0.0.1:8787/admin
```

当前支持：

- 查看运行状态
- 拉取并展示 Vertex 可用模型
- 修改网络、鉴权、日志、重试、思考相关配置
- 修改默认生成参数
- 导入服务账号 JSON
- 修改控制台密码

## 常用环境变量

### 网络

- `HOST`
  默认 `0.0.0.0`
- `PORT`
  默认 `8787`

如果只允许本机访问：

```env
HOST=127.0.0.1
```

如果需要局域网、NAT、端口映射或公网访问：

```env
HOST=0.0.0.0
```

### Vertex

- `GOOGLE_APPLICATION_CREDENTIALS`
  服务账号 JSON 文件路径
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
  直接把完整 JSON 放在环境变量中
- `VERTEX_PROJECT_ID`
  GCP 项目 ID
- `VERTEX_LOCATION`
  默认 `global`
- `VERTEX_MODEL`
  当客户端没有传 `model` 时使用的默认模型

### 代理鉴权

- `OPENAI_API_KEY`
  上游客户端访问代理时使用的 Bearer Key

客户端请求头示例：

```http
Authorization: Bearer your-local-proxy-key
```

### 控制台鉴权

- `ADMIN_PASSWORD`
  管理控制台密码

### 默认生成参数

- `DEFAULT_TEMPERATURE`
- `DEFAULT_TOP_P`
- `DEFAULT_TOP_K`
- `DEFAULT_MAX_OUTPUT_TOKENS`

这些值会在客户端没有显式传入对应参数时作为默认值使用。

### 思考与流式

- `INCLUDE_THOUGHTS`
  是否请求 Gemini 思考内容
- `ENABLE_STREAMING`
  是否允许流式传输
- `THOUGHTS_MODE`
  可选：
  - `reasoning_content`
  - `content`
  - `off`
- `THINKING_BUDGET`
  传给 Gemini 的思考预算

建议理解：

- `reasoning_content`
  用 OpenAI 风格字段返回思考内容
- `content`
  把思考内容塞进普通文本，更适合兼容性一般的客户端
- `off`
  不输出思考内容

### 日志与重试

- `LOG_LEVEL`
  可选：`error`、`info`、`debug`
- `MAX_FETCH_ATTEMPTS`
  Google OAuth 和 Vertex 请求失败时的最大重试次数
- `FETCH_RETRY_DELAY_MS`
  重试间隔毫秒数

## OpenAI 兼容接口

### 健康检查

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/healthz
```

### 获取模型列表

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/v1/models
```

强制刷新模型缓存：

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:8787/v1/models?refresh=1
```

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

## Cherry Studio 接入

推荐这样填写：

- Base URL: `http://127.0.0.1:8787/v1`
- API Key: 你在 `.env` 中设置的 `OPENAI_API_KEY`
- Model: 直接填写 `Gemini` 原始模型名

例如：

```text
gemini-3.1-pro-preview
```

如果客户端看不到思考内容，可以尝试：

```env
THOUGHTS_MODE=content
```

## SillyTavern / 其他 OpenAI 兼容客户端

只要客户端支持 OpenAI 兼容接口，一般都可以这样接：

- Base URL 指向：`http://127.0.0.1:8787/v1`
- API Key 填写：`OPENAI_API_KEY`
- 模型名直接使用 `/v1/models` 返回的原始 ID

## NAT / 外网访问

如果希望其他设备通过局域网、公网、内网穿透或端口映射访问：

1. 在 `.env` 中保持：

```env
HOST=0.0.0.0
PORT=8787
```

2. 放行本机防火墙端口
3. 配置路由器、云防火墙或端口映射规则
4. 强烈建议设置 `OPENAI_API_KEY`

如果代理暴露到外网但没有配置 `OPENAI_API_KEY`，任何能访问该地址的人都可能消耗你的 Vertex 配额。

## 常见问题

### 1. 启动成功，但提示需要配置

说明服务已经启动，但还没有导入服务账号 JSON。

处理方式：

- 打开 `http://127.0.0.1:8787/admin`
- 登录控制台
- 导入服务账号 JSON

### 2. `run.bat` 提示没有 Node.js

说明系统没有安装 Node.js，或者 `node` / `npm` 没加入环境变量。

### 3. 提示端口被占用

说明 `HOST:PORT` 已被其他进程占用。

处理方式：

- 关闭旧进程
- 或者在 `.env` 中修改 `PORT`

### 4. 拉取模型失败

通常检查这几项：

- 服务账号是否正确
- `VERTEX_PROJECT_ID` 是否正确
- 服务账号是否有 Vertex 权限
- 机器能否访问 Google API

### 5. 流式输出不生效

检查：

- `ENABLE_STREAMING=true`
- 客户端是否真的发送了 `stream: true`
- 客户端自身是否支持 SSE 流显示

## 安全建议

- 不要把 `.env` 提交到 Git 仓库
- 不要把 `service-account.json` 提交到 Git 仓库
- 仓库公开时，务必确认 `.gitignore` 生效
- 如果服务账号曾经泄露，立即去 Google Cloud 轮换密钥
- 如果开放公网访问，务必设置强密码和 `OPENAI_API_KEY`

## 许可证

如需公开发布，建议你在仓库中补充自己的许可证文件。
