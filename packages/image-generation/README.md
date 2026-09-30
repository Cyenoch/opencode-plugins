# opencode-image-generation

OpenCode **V2** 图片生成插件。为 AI 注册 `generate_image` 工具，通过 OpenAI 兼容的 `POST /images/generations` 接口生成图片、保存文件，并返回 V2 文件附件及绝对路径。

## 安装和配置

本包位于 `opencode-plugins` monorepo 的 `packages/image-generation`，直接以源码运行，无需构建。目标插件 API 为 `@opencode/plugin` 2.0.20。在仓库根目录安装依赖：

```sh
bun install
```

在需要使用插件的项目 `opencode.jsonc`，或全局 `~/.config/opencode/opencode.jsonc` 中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/opencode-plugins/packages/image-generation",
      "options": {
        "model": "openai/gpt-image-2.5-flare"
      }
    }
  ]
}
```

先通过 OpenCode `/connect` 为对应 provider 配置 **API Key**，或向 OpenCode 服务进程提供 `OPENAI_API_KEY`。插件按调用时的连接解析密钥，不将密钥写入生成结果。修改源码后，若未自动重载，运行 `opencode service restart`。

随后可以直接对 AI 说：

> 使用 generate_image 生成一张水彩风格的小水獭插画，1024×1024。

### Flare / Sunburst

根据 [OpenAI 图片生成文档](https://developers.openai.com/api/docs/guides/image-generation)，这两个模型的配置分别是：

```text
openai/gpt-image-2.5-flare
openai/gpt-image-2.5-sunburst
```

插件只按**第一个 `/`** 拆分 provider 和模型，其余内容原样发送给接口。例如 `gateway/vendor/image-model` 将使用 provider `gateway`，向接口发送模型 `vendor/image-model`。

`openai/gpt-image-2.5-flare/sunburst` 因此会发送完整模型 ID `gpt-image-2.5-flare/sunburst`，不是两个模型间的自动选择；只有网关确实定义了这个 ID 时才这样配置。

### 自定义网关

可以复用 OpenCode provider 的 `settings.baseURL`、`headers`、`settings.apiKey` 和关联的 Integration API Key 连接。也可以在插件选项里独立配置图片服务，无需将图片模型加入 OpenCode 的对话模型目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/opencode-plugins/packages/image-generation",
      "options": {
        "model": "images/gpt-image-2.5-sunburst",
        "providers": {
          "images": {
            "baseURL": "https://your-gateway.example/v1",
            "apiKeyEnv": "IMAGE_API_KEY",
            "headers": { "X-Tenant": "my-team" },
            "body": { "output_compression": 90 }
          }
        },
        "defaults": {
          "size": "1024x1024",
          "quality": "high",
          "output_format": "webp"
        }
      }
    }
  ]
}
```

`baseURL` 应是 API 根地址（通常以 `/v1` 结尾），插件追加 `/images/generations`。不支持包含查询参数、片段或内嵌用户名密码的 baseURL。

配置中的 `apiKeyEnv` 是**环境变量名称**。该环境变量必须存在于 OpenCode **服务进程**，仅在已运行服务之外的终端执行 `export` 不会更新服务环境。

## 工具参数

```json
{
  "prompt": "一只戴橙色围巾的小水獭，水彩插画，浅色背景",
  "model": "openai/gpt-image-2.5-sunburst",
  "size": "1024x1024",
  "quality": "high",
  "background": "opaque",
  "output_format": "png",
  "n": 1
}
```

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，图片描述 |
| `model` | 可选，覆盖插件默认 `provider/model` |
| `size` | 可选，接口支持的尺寸，如 `1024x1024` 或 `auto` |
| `quality` | 可选，接口支持的质量等级 |
| `background` | 可选，`auto` / `transparent` / `opaque` |
| `output_format` | 可选，`png` / `jpeg` / `webp` |
| `n` | 1–4，默认 1；还须满足模型自身的数量限制 |

图片默认保存到**执行工具的会话目录**下的 `generated-images/image-随机后缀/1.png`。每次调用使用独立目录，支持并发且不覆盖既有文件。附件使用 `file://` URI；能否直接显示缩略图由客户端决定，AI 也可根据返回的路径读取图片。

## 插件选项

| 选项 | 默认值 / 作用 |
| --- | --- |
| `model` | 无；若不配置，则每次调用必须传入模型 |
| `outputDir` | `generated-images`；相对会话目录，也可指定绝对路径 |
| `timeoutMs` | `180000`；图片请求、下载及保存共用的超时时间 |
| `maxImageBytes` | `20971520`（20 MiB）；每张图片最大大小 |
| `defaults` | `size`、`quality`、`background`、`output_format` 默认值 |
| `providers.<id>.baseURL` | 覆盖 OpenCode provider 的图片 API 根地址 |
| `providers.<id>.apiKeyEnv` | 从指定环境变量获取 Bearer API Key |
| `providers.<id>.integrationID` | 覆盖需要复用的 OpenCode Integration ID |
| `providers.<id>.headers` | 覆盖 / 追加 provider HTTP headers |
| `providers.<id>.body` | 附加 Images API JSON 参数，如 `response_format`、`output_compression` |

请求参数优先级：`provider.body`（插件配置）→ `defaults` → 单次工具参数。`prompt`、`model`、`n` 始终由实际调用决定。OpenCode 对话 provider / model 的 `body` 和模型别名不会自动应用到 Images API；`model` 后缀应填写上游实际接收的模型 ID。

鉴权优先级：显式 `apiKeyEnv` → 已配置的 `Authorization` header → provider `settings.apiKey` → `OPENAI_API_KEY`（仅 `openai`）→ OpenCode Integration API Key。没有凭据时允许匿名请求，以支持本地服务。OAuth 连接不能自动视为 Images API 凭据；可用 `apiKeyEnv` 指定独立 API Key。

## 支持范围

- 文生图，兼容 `data[].b64_json` 和 `data[].url` 响应。
- 识别 PNG、JPEG、WebP、GIF 文件头；文件扩展名与实际返回格式一致。
- 支持取消和超时；下载图片不携带 provider 鉴权 headers；HTTP 重定向会报错。
- 不自动重试生成请求，避免重复计费。HTTP 错误返回状态码，不将上游原始错误正文回传给 AI。
- 当前使用非流式 Images API；不处理 Responses API、参考图编辑或流式预览。`body` 中也不要设置 `stream: true`。
- 不调用模型目录校验接口，图片模型是否可用取决于配置的上游。

## 开发与验证

```sh
bun run check
bun test
```

测试使用本地 HTTP 服务，验证 V2 工具注册、请求模型和参数、鉴权、图片附件及落盘、URL 下载、错误、超时、取消、并发和输入限制，不会调用付费图片接口。

源码：`src/index.ts` 注册插件；`src/config.ts` 定义参数；`src/provider.ts` 解析连接；`src/images.ts` 处理图片接口；`src/generate.ts` 保存并返回结果。

参考：[V2 插件 API](https://opencode.ai/v2/docs/build/plugins)、[V2 插件配置](https://opencode.ai/v2/docs/plugins)、[V2 providers](https://opencode.ai/v2/docs/providers)。
