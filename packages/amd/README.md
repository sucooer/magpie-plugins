# magpie-plugin-amd

[magpie](https://usemagpie.ai) / OpenCode 供应商插件：**AMD TokenFactory（Radeon Cloud）**。

把 AMD TokenFactory 的模型接入 magpie，agent 可以用 `amd/<模型>` 访问，和其他供应商一样。

## 上游 API

| 项 | 值 |
| --- | --- |
| Base URL | `https://developer.amd.com.cn/radeon/api/v1` |
| 鉴权 | `Authorization: Bearer <rc- 开头的 API key>` |
| 模型目录 | `GET /models`（自描述：`context_length`、`providers[].tools/vision`、`free`） |
| 推理 | `POST /chat/completions`（OpenAI 兼容，SSE 流式） |
| 负载状态 | `GET https://developer.amd.com.cn/radeon/api/tokenfactory/load`（无需 key，约 25s 响应） |

API key 在 [developer.amd.com.cn/radeon/tokenfactory](https://developer.amd.com.cn/radeon/tokenfactory) 申请。

## 登录方式

**粘贴 API key**：支持一次粘贴多个 key（逗号 / 换行分隔），存进一个 magpie 账号。
请求按 round-robin 轮换使用所有 key，把负载摊到每个 key 的限流额度（~30 req/min、8 并发）上；
遇到 401/403/429 自动换下一个 key 重试。登录时用第一个 key 拉一次 `/models` 校验有效性。

key 以 JSON 数组形式存在 magpie 的 `plugin-auth.json`（权限 600），单个 key 的旧形态自动兼容。

## 移植自 VS Code 扩展的网关适配

AMD 网关有几个已知怪癖（VS Code 扩展实测结论），插件在转发前自动处理：

- **参数白名单**：网关静默丢弃 `stop` / `seed` / `logit_bias` / `logprobs` 等参数，插件直接剥掉避免歧义；
- **system 消息必须排最前**，插件自动重排；
- **kimi 系模型**拒绝没有 `reasoning_content` 的 assistant 历史条目，插件自动补占位符；
- **thinking 模型**（DeepSeek R1/V4、Kimi K3/K2.6、GLM 5.x、GPT-OSS、QwQ 等）的内部推理
  消耗 `max_tokens` 预算，插件强制输出预算下限 16384，避免推理吃光预算导致截断；
- **重试**：429/502/503/504 指数退避 + 全抖动重试（最多 3 次），尊重 `Retry-After` 头。

## 模型目录

- 动态拉取 `GET /models`，无硬编码目录；
- 自动过滤非 chat 模型（embedding / rerank / guard / base completion 等）；
- 能力位（vision / reasoning / free）读上游自描述字段；
- 目录进程内缓存 10 分钟。

## 环境变量（可选覆盖）

| 变量 | 默认 |
| --- | --- |
| `AMD_TOKENFACTORY_BASE_URL` | `https://developer.amd.com.cn/radeon/api/v1` |
| `AMD_TOKENFACTORY_LOAD_URL` | `https://developer.amd.com.cn/radeon/api/tokenfactory/load` |

## 安装

```bash
# npm 包
magpie plugin add magpie-plugin-amd

## 测试

```bash
node --test     # 单元测试（纯函数，不打上游；Node 18+ 内置测试器，零依赖）
```

在 monorepo 根目录也可以跑：`npm run test:amd`。

## 免责

本项目仅用于个人学习与研究，与 AMD 无任何关联，未获得其授权、认可或赞助。
