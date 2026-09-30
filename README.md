# opencode-plugins

OpenCode **V2** 插件集合（Bun workspaces monorepo）。

| 包 | 说明 |
| --- | --- |
| [`packages/image-generation`](./packages/image-generation) | 注册 `generate_image` 工具，调用 OpenAI 兼容的 Images API 生成图片 |
| [`packages/image-optimizer`](./packages/image-optimizer) | 在 `read` 返回静态图片时自动压缩/转码，控制上下文体积 |

## 安装

```sh
bun install
```

## 开发

```sh
bun run check   # 逐包 tsc --noEmit
bun test        # 运行所有包测试
bun run lint    # Biome
bun run format  # Biome 自动格式化
```

## 在 OpenCode 中使用

本地目录插件要求包根目录存在入口文件（`index.ts`）。OpenCode 的本地目录加载器**不读取**
`package.json` 的 `exports`，因此每个包都提供根 `index.ts` 转发到 `src/index.ts`。

在全局 `~/.config/opencode/opencode.json` 或项目 `opencode.jsonc` 中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/opencode-plugins/packages/image-generation", "options": {} },
    { "package": "/absolute/path/opencode-plugins/packages/image-optimizer", "options": {} }
  ]
}
```

修改源码后，若未自动重载，运行 `opencode service restart`。

## 要求

- Bun ≥ 1.4（workspaces、内置 test runner）
- OpenCode V2 ≥ 2.0.20
