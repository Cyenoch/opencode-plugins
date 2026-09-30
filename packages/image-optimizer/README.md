# OpenCode Image Optimizer

OpenCode **V2** 服务端插件：自动优化 `read` 返回的静态 PNG、JPEG、WebP 图片。使用 Sharp/libvips；针对 OpenCode **2.0.20** 的真实工具调用链测试。

## 安装和启用

本包位于 `opencode-plugins` monorepo 的 `packages/image-optimizer`。在仓库根目录安装依赖：

```sh
bun install
```

将下面的插件项加入项目或全局 `opencode.json(c)` 的 `plugins` 数组，保留已有插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-image-optimizer",
      "options": {
        "targetBytes": 1048576,
        "quality": 92,
        "minQuality": 85,
        "allowResize": false,
        "rules": [
          {
            "provider": "your-webp-capable-provider",
            "formats": ["webp", "jpeg", "png"]
          },
          {
            "provider": "your-webp-capable-provider",
            "model": "legacy-*",
            "formats": ["jpeg", "png"]
          }
        ]
      }
    }
  ]
}
```

路径应指向整个插件目录，例如 `.../opencode-plugins/packages/image-optimizer`。换机器时修改路径。OpenCode 的本地目录加载器读取根 `index.ts`，**不读取** `package.json` 的 `exports`，因此本包在根目录提供 `index.ts` 转发到 `src/index.ts`。

配置重新加载后，对新执行的 `read` 生效；下一次模型请求也会检查上下文中旧的 `read` 图片。如果插件未被加载，可运行 `opencode service restart` 后重新打开会话。

## 行为

- 原生 `read` 完成路径解析及权限检查后，`execute.after` hook 优化结果中的图片。
- 已是 WebP 且超出体积目标时，仍进行重新编码；已满足要求的同格式图片直接复用。
- 每个候选版本都从相同原始输入生成，默认尝试 quality **92 → 88 → 85**。
- 默认保留像素尺寸；设置 `allowResize: true` 后，质量下限仍不能满足目标时才等比例缩小。硬尺寸限制会先执行。
- 输出格式列表有序：第一个是优先格式，其余是可接受格式。兼容的原图更小时可能保留原图；要强制 WebP，配置 `formats: ["webp"]`。
- 透明图片在 JPEG/PNG 策略下使用 PNG。JPEG-only 策略不会静默丢弃透明通道。
- 自动纠正 EXIF 方向、转到 sRGB；不会覆盖磁盘原图。
- 同时更新原生 `read` 的 `content` 和重复保存图片的结构化 `output`，避免留下未压缩副本。
- `context`、`compaction`、`generate`、`title` hooks 按实际请求模型重新检查 `read` 结果；修改仅作用于出站消息。
- 文本、目录、PDF、SVG、GIF、外部 URL、用户直接上传的附件以及其他工具结果不属于本插件处理范围。动画 PNG/WebP 保持原样；若无法满足明确的格式/硬限制，则报错，不静默丢帧。

### 格式兼容

默认对 provider ID `openai`、`anthropic` 优先使用 WebP；其他 provider 默认 JPEG/PNG。这是可覆盖的策略表，不是在线能力探测。如果上述 ID 配置了不支持 WebP 的代理端点，也应添加规则覆盖。

`rules` 按顺序匹配，后面的规则覆盖前面相同字段。`provider` 和 `model` 支持 `*` 通配，匹配 OpenCode 的 provider/model ID，而不是显示名称。

### 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `formats` | 按 provider 选择 | 可接受的 `webp`、`jpeg`、`png`，首项优先 |
| `targetBytes` | `1048576` | 压缩后原始字节的软目标，不含 base64 开销 |
| `quality` | `92` | 起始有损编码质量 |
| `minQuality` | `85` | 有损质量下限；不等于可感知质量保证 |
| `allowResize` | `false` | 是否允许插件缩小图片 |
| `minDimension` | `1024` | 为达到体积目标而缩放时的长边下限，不放大小图 |
| `maxDimension` | 无 | 长边硬上限；超过时必须允许缩放，否则报错 |
| `maxBytes` | 无 | 单图编码字节硬上限 |
| `maxBase64Bytes` | 无 | 单图 base64 字符串字节硬上限，不含 data URL 前缀 |
| `cacheBytes` | `268435456` | 每个 location 的磁盘缓存预算，含原始输入和变体 |
| `cacheDirectory` | `$XDG_CACHE_HOME/opencode-image-optimizer` 或 `~/.cache/opencode-image-optimizer` | 缓存根目录，必须是绝对路径 |
| `debug` | `false` | 输出压缩前后字节数，不输出图片内容 |
| `rules` | `[]` | provider/model 规则，可覆盖所有图像参数，不含缓存/debug |

软目标无法达到时，返回符合硬限制的最小候选版本。硬限制无法达到时抛出错误。普通编码故障在能够确认格式/字节兼容且没有待验证硬尺寸约束时保留输入图片。单图最多解码 1 亿像素；图片处理串行执行，避免并行 `read` 让多个大图同时编码。

例如允许缩放，并要求单图 base64 不超过 4 MiB：

```jsonc
{
  "targetBytes": 1048576,
  "allowResize": true,
  "minDimension": 1024,
  "maxBase64Bytes": 4194304
}
```

这是单图策略，不是整次请求的总量预算。WebP 减小传输体积，但不保证减少视觉 token。

## 与 OpenCode 内置图片处理的关系

OpenCode V2 在 `execute.after` 之后还有内置图片规范化步骤，默认限制约为 **2000×2000、base64 5 MiB**。大图可能被内核缩小并转成 PNG/JPEG；请求 hook 会再次检查这些 `read` 图片的输出格式。

因此，本插件 `allowResize: false` 只约束插件本身。要保留超过 2000 像素的图像，还需在 OpenCode 根配置中调整 `media.image`，例如：

```jsonc
{
  "media": {
    "image": {
      "auto_resize": true,
      "max_width": 4096,
      "max_height": 4096,
      "max_base64_bytes": 5242880
    }
  }
}
```

这不是插件 option。应根据目标 API 能力设置；`auto_resize: false` 会拒绝超限图片，并不表示取消尺寸/体积限制。

## 缓存

缓存按 location 路径隔离，使用内容 SHA-256、编码参数、Sharp/libvips 版本识别变体。缓存原始输入，切换 provider 或修改压缩策略时优先从原始输入生成，重启后仍可复用。使用原子写入和 LRU 淘汰，同时最多保留 512 个来源条目。

缓存被清理/淘汰，或 OpenCode 内核在插件后又改变图片字节时，原图映射可能无法恢复；此时以历史中现有图片为输入。不会重新打开原始文件路径，因此原文件后续修改不会改变历史图像内容。缓存只是优化，不是原图归档。

## 验证

```sh
bun run check
bun test
bun run test:smoke
```

- 单元/集成测试使用真实 Sharp 编码，覆盖文字截图像素误差、已有 WebP 再压缩、透明度、动图、硬限制、缓存重启和淘汰、模型切换、原始结果不变等。
- `test:smoke` 需要 PATH 中有 OpenCode V2。启动独立 OpenCode 和本地模拟模型 API，让模型调用原生 `read`，验证 API 实际收到 WebP；不调用付费模型。
- 测试隔离配置、数据库和缓存，结束后清理临时目录。
- 已验证 1600×1200 文字截图：PNG **238,023 B** → WebP **137,534 B**，减少约 **42.2%**，分辨率不变。压缩比依图片而变；合成截图误差测试不等于所有 OCR 任务的准确率保证。

源码入口为 `src/index.ts`，配置、编码、缓存、结果转换分别在 `src/config.ts`、`src/compress.ts`、`src/cache.ts`、`src/hooks.ts`。
