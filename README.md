# Mattermost AI Bot

一个运行在 Mattermost 里的 AI 助手服务。它通过 Mattermost WebSocket 监听消息，在被提及、参与线程、或收到明确命令时回复。

当前版本偏向内部团队使用，支持 OpenAI 兼容 API、图片生成/编辑、附件理解、LightRAG 查询、联网搜索、线程退出，以及长消息自动分段。

## 功能

- 普通对话：`@chatgpt 问题`
- 线程续聊：bot 参与过的 thread 内可继续直接回复
- 联网搜索：`/search`，可用 `--force` 强制调用 web search
- LightRAG：`/rag`，通过 Ollama 兼容接口查询知识库
- 图片生成：`/image`，支持参考图
- 原始图片提示词：`/image --raw`
- 附件理解：图片、文本、代码、CSV、JSON、Markdown、DOCX、XLSX
- 线程控制：`/leave` 退出当前线程，`/join` 恢复
- 长消息保护：按 UTF-8 字节分段，失败后自动小块重试
- 白名单/黑名单：按用户或频道控制响应范围

## 命令

```text
@chatgpt 普通问题
@chatgpt /search 问题
@chatgpt /search --force 问题
@chatgpt /rag 问题
@chatgpt /rag --mode mix 问题
@chatgpt /image 图片描述
@chatgpt /image --raw 原始图片提示词
@chatgpt /leave
/join
```

说明：

- `/search` 只是允许模型使用 web search，模型可能判断不需要联网。
- `/search --force` 会强制调用 web search。
- `/leave` 后当前线程不会再自动触发 bot。
- `/join` 可在同一线程恢复 bot，通常不需要 `@chatgpt`。
- 已移除截图、引用 URL 展示、locale/domain 限定等不稳定搜索功能。

## 环境变量

### 必填

| 变量 | 说明 |
| --- | --- |
| `MATTERMOST_URL` | Mattermost 地址，例如 `http://mattermost:8080` |
| `MATTERMOST_TOKEN` | Mattermost bot token |
| `OPENAI_API_KEY` | OpenAI 或兼容 API key |

### OpenAI / 兼容 API

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_API_BASE` | OpenAI 官方地址 | OpenAI 兼容 API base URL |
| `OPENAI_MODEL_NAME` | `gpt-4.1` | 普通聊天、搜索、LightRAG 后处理等使用的模型 |
| `OPENAI_MAX_TOKENS` | `8192` | 输出 token 上限 |
| `OPENAI_TEMPERATURE` | `1` | 采样温度 |
| `OPENAI_WEB_SEARCH_TOOL` | `web_search` | 可设为 `web_search` 或 `web_search_preview` |
| `OPENAI_WEB_SEARCH_MAX_TOKENS` | 同 `OPENAI_MAX_TOKENS` | `/search` 输出 token 上限 |
| `OPENAI_WEB_SEARCH_CONTEXT_SIZE` | `medium` | `low`、`medium`、`high` |

注意：`OPENAI_BASE_PATH` 不被代码使用，请使用 `OPENAI_API_BASE`。

### 图片

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | 图片生成模型 |
| `OPENAI_IMAGE_EDIT_MODEL` | 同 `OPENAI_IMAGE_MODEL` | 图片编辑模型 |
| `OPENAI_IMAGE_QUALITY` | `auto` | `auto`、`low`、`medium`、`high`、`standard` |
| `OPENAI_IMAGE_SIZE` | `auto` | `auto`、`1024x1024`、`1536x1024`、`1024x1536`、`match-reference` |
| `OPENAI_IMAGE_MAX_INPUT_EDGE` | `2048` | 参考图最大边 |
| `OPENAI_IMAGE_MAX_INPUT_PIXELS` | `4000000` | 参考图最大像素量 |
| `OPENAI_IMAGE_MAX_INPUT_BYTES` | `8388608` | 参考图预处理后目标大小 |
| `OPENAI_IMAGE_JPEG_QUALITY` | `90` | JPEG 转码质量 |

图片参考图会自动缩放、转码和按比例选择输出尺寸，减少大图或非正方形图片导致的失败。

### LightRAG

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIGHTRAG_BASE_URL` | 无 | LightRAG API Server 地址，例如 `http://lightrag:9621` |
| `LIGHTRAG_MODEL` | `lightrag:latest` | LightRAG Ollama 兼容模型名 |
| `LIGHTRAG_API_KEY` | 无 | 如启用鉴权则填写 |
| `LIGHTRAG_DEFAULT_MODE` | 无 | 可设 `local`、`global`、`hybrid`、`naive`、`mix`、`context` |

`/rag --mode mix 问题` 会向 LightRAG 发送 `/mix 问题`。不指定 mode 时使用 `LIGHTRAG_DEFAULT_MODE`；也未设置时直接发送原问题。

### Mattermost 行为

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MATTERMOST_BOTNAME` | `@chatgpt` | bot 在 Mattermost 中的 mention 名称 |
| `BOT_CONTEXT_MSG` | `100` | 传给模型的线程上下文消息数 |
| `BOT_INSTRUCTION` | 内置中文提示词 | 自定义系统提示 |
| `PLUGINS` | Docker 默认 `image-plugin` | 当前主要用于启用图片插件 |
| `MATTERMOST_MAX_POST_BYTES` | 同 `MATTERMOST_MAX_POST_CHARS` | 单条 Mattermost 回复目标 UTF-8 字节数 |
| `MATTERMOST_MAX_POST_CHARS` | `12000` | 兼容旧配置；建议改用 bytes |
| `MATTERMOST_RETRY_POST_BYTES` | `4000` | 发帖失败后的更小重试块 |

推荐：

```yaml
MATTERMOST_MAX_POST_BYTES: 7000
MATTERMOST_RETRY_POST_BYTES: 4000
```

### 附件限制

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_MAX_ATTACHMENT_BYTES` | `10485760` | 单个附件最大大小 |
| `OPENAI_MAX_ATTACHMENT_COUNT` | `4` | 单条消息最多处理附件数 |
| `OPENAI_MAX_ATTACHMENT_TEXT_CHARS` | `20000` | 单个文档提取文本上限 |
| `OPENAI_MAX_ATTACHMENT_TEXT_BUDGET` | `30000` | 所有文档文本总预算 |
| `OPENAI_MAX_SPREADSHEET_SHEETS` | `5` | XLSX 最大 sheet 数 |
| `OPENAI_MAX_SPREADSHEET_ROWS` | `50` | XLSX 每个 sheet 最大行数 |
| `OPENAI_MAX_SPREADSHEET_COLS` | `20` | XLSX 每行最大列数 |
| `OPENAI_ATTACHMENT_CACHE_TTL_MS` | `300000` | 附件解析缓存时间 |

### 黑白名单

| 变量 | 说明 |
| --- | --- |
| `MATTERMOST_BOT_WHITELIST_USER` | 逗号分隔的 Mattermost user id |
| `MATTERMOST_BOT_WHITELIST_CHANNEL` | 逗号分隔的 channel id |
| `MATTERMOST_BOT_BLACKLIST_USER` | 逗号分隔的 Mattermost user id |
| `MATTERMOST_BOT_BLACKLIST_CHANNEL` | 逗号分隔的 channel id |

白名单存在时，只允许白名单用户或频道触发。黑名单会直接忽略对应用户或频道。

## Docker Compose 示例

```yaml
services:
  chatbot:
    build: .
    restart: unless-stopped
    environment:
      MATTERMOST_URL: http://mattermost:8080
      MATTERMOST_TOKEN: your_mattermost_bot_token
      MATTERMOST_BOTNAME: "@chatgpt"

      OPENAI_API_KEY: your_api_key
      OPENAI_API_BASE: http://your-openai-compatible-endpoint/v1
      OPENAI_MODEL_NAME: gpt-5.5
      OPENAI_WEB_SEARCH_TOOL: web_search
      OPENAI_WEB_SEARCH_MAX_TOKENS: 2048
      OPENAI_WEB_SEARCH_CONTEXT_SIZE: medium

      OPENAI_IMAGE_QUALITY: medium
      OPENAI_IMAGE_SIZE: auto

      LIGHTRAG_BASE_URL: http://lightrag:9621
      LIGHTRAG_MODEL: lightrag:latest
      LIGHTRAG_DEFAULT_MODE: hybrid

      MATTERMOST_MAX_POST_BYTES: 7000
      MATTERMOST_RETRY_POST_BYTES: 4000

      MATTERMOST_BOT_BLACKLIST_USER: user_id_1,user_id_2
      MATTERMOST_BOT_BLACKLIST_CHANNEL: channel_id_1,channel_id_2
```

不要把真实 token 或 API key 提交到仓库。

## 本地开发

需要 Node.js 20+。

```bash
npm install
npm run build
npm run start
```

`npm run start` 使用 `ts-node` 直接运行 `src/botservice.ts`。

## Docker 构建

```bash
docker build -t chatgpt-mattermost-bot .
```

运行：

```bash
docker run -d --restart unless-stopped \
  -e MATTERMOST_URL=http://mattermost:8080 \
  -e MATTERMOST_TOKEN=your_mattermost_bot_token \
  -e OPENAI_API_KEY=your_api_key \
  -e OPENAI_API_BASE=http://your-openai-compatible-endpoint/v1 \
  --name chatbot \
  chatgpt-mattermost-bot
```

如果 Mattermost 使用私有 CA，可挂载证书并设置：

```yaml
NODE_EXTRA_CA_CERTS: /certs/root.crt
```

## 设计说明

- bot 只会响应被提及的根消息，或自己已参与的线程。
- `/leave` 可阻止多个 bot 在同一线程里互相触发。
- 长回复会拆成多条 Mattermost thread 回复。
- 图片参考图会预处理后再传给图片编辑模型。
- LightRAG 作为独立 `/rag` 入口，不会替代主 OpenAI API。

## License

MIT. See [license.md](./license.md).
