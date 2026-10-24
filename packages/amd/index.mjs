/**
 * magpie / OpenCode provider plugin: AMD TokenFactory (Radeon Cloud)
 *
 * 移植自 VS Code 扩展 sucooer/amd-tokenfactory-provider (TypeScript):
 *   - src/api.ts            → fetchWithRetry (429/502/503/504 指数退避 + 全抖动),
 *                             /models 目录 (裸数组或 {data:[...]} 信封都认)
 *   - src/key-rotation.ts   → key 池 round-robin 轮换 + 掩码
 *   - src/model-catalog.ts  → 非 chat 模型过滤, 能力位归一化
 *   - src/constants.ts      → thinking 模型判定, 输出预算下限
 *   - src/streaming/openai.ts → thinking 模型 max_tokens 下限 (16384)
 *   - src/adapters/index.ts → kimi 系 assistant 历史补 reasoning_content 占位
 *   - src/guidance.ts       → system 消息必须排最前 (网关要求)
 *
 * 上游 API 形态 (developer.amd.com.cn):
 *   Base URL   https://developer.amd.com.cn/radeon/api/v1
 *   Auth       Authorization: Bearer <rc- 开头的 key>
 *   模型目录   GET  /models        (自描述: context_length / providers[].tools|vision / free)
 *   推理       POST /chat/completions  (OpenAI 兼容, SSE 流式)
 *   负载状态   GET  https://developer.amd.com.cn/radeon/api/tokenfactory/load (无需 key, ~25s)
 *
 * 网关已知怪癖 (VS Code 扩展实测结论):
 *   - 静默丢弃非白名单参数 (stop / seed / logit_bias / logprobs ...)
 *   - system 消息必须排在最前
 *   - kimi 系模型拒绝没有 reasoning_content 的 assistant 历史条目
 *   - thinking 模型 (deepseek-r1/v4, kimi-k*, glm-5, gpt-oss, qwq ...) 的
 *     内部推理消耗 max_tokens 预算, 需要输出预算下限
 *   - 限流: ~30 req/min/key, 8 并发/key
 *
 * 本插件纯依赖 Bun/Node 标准库, 零 npm 运行时依赖. 测试: `bun test`.
 */

const PROVIDER_ID = "amd";
const PROVIDER_NAME = "AMD TokenFactory";

const BASE_URL = trimSlash(process.env.AMD_TOKENFACTORY_BASE_URL) || "https://developer.amd.com.cn/radeon/api/v1";
const LOAD_URL = trimSlash(process.env.AMD_TOKENFACTORY_LOAD_URL) || "https://developer.amd.com.cn/radeon/api/tokenfactory/load";

/** 目录进程内缓存 TTL; VS Code 扩展用 globalState 持久缓存, 这里同档 10 分钟 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 重试策略 (api.ts): 429/502/503/504 可重试, 最多 3 次, 指数退避 + 全抖动 */
const RETRYABLE_STATUSES = [429, 502, 503, 504];
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/** thinking 模型输出预算下限 (streaming/openai.ts): 推理先吃预算, 16K 起步 */
const THINKING_MIN_OUTPUT_TOKENS = 16384;
/** 默认输出上限 (model-catalog.ts DEFAULT_MAX_OUTPUT_TOKENS) */
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
/** 默认上下文窗口 (model-catalog.ts DEFAULT_CONTEXT_WINDOW) */
const DEFAULT_CONTEXT_WINDOW = 131072;

/** thinking 模型 ID 判定 (constants.ts THINKING_MODEL_ID_PATTERNS) */
const THINKING_MODEL_ID_PATTERNS = [
  /(^|[\/_-])deepseek-r1([\/_-]|$)/i,
  /(^|[\/_-])deepseek-v4([\/_-]|$)/i,
  /(^|[\/_-])kimi-k\d([.\/_-]|$)/i,
  /(^|[\/_-])glm-5([.\/_-]|$)/i,
  /(^|[\/_-])gpt-oss([\/_-]|$)/i,
  /(^|[\/_-])minimax-m3([\/_-]|$)/i,
  /(^|[\/_-])nemotron-3([\/_-]|$)/i,
  /(^|[\/_-])nemotron-super([\/_-]|$)/i,
  /(^|[\/_-])cosmos-reason\d*([\/_-]|$)/i,
  /(^|[\/_-])qwq([\/_-]|$)/i,
];

/** 非 chat 模型过滤 (model-catalog.ts NON_CHAT_MODEL_ID_PATTERNS) */
const NON_CHAT_MODEL_ID_PATTERNS = [
  /(^|[/_-])bge([-_/]|$)/i,
  /(^|[/_-])(clip|detector|embed|embedcode|embedqa|embedding|gliner|parse|rerank|retriever|reward)([-_/]|$)/i,
  /(^|[/_-])nv(clip|embed|embedcode|embedqa|retriever|rerank)([-_/]|$)/i,
  /(^|[/_-])(guard|safety|nemoguard)([-_/]|$)/i,
  /(^|[/_-])(codegemma|codellama|starcoder\d*)([-_/]|$)/i,
  /(^|[/_-])llama2([-_/]|$)/i,
  /(^|[/_-])(gemma-2b|recurrentgemma|diffusiongemma)([-_/]|$)/i,
  /(^|[/_-])(riva|translate|calibration)([-_/]|$)/i,
];

function trimSlash(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isThinkingModel(modelId) {
  return THINKING_MODEL_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function isChatModelId(modelId) {
  return !NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.includes(status);
}

function maskApiKey(key) {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "••••••••";
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// key 池: 一个 magpie 账号里存多个 key (JSON 数组), round-robin 轮换.
// magpie 的 auth.access 就是 VS Code 扩展 SecretStorage 的等价物.
// ---------------------------------------------------------------------------

function parseKeyPool(access) {
  const raw = typeof access === "string" ? access.trim() : "";
  if (!raw) return [];
  // 兼容旧形态: 单个 key 直接存 (VS Code 扩展的 legacy 迁移同款思路)
  if (!raw.startsWith("[")) return [raw];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const keys = [];
    for (const entry of parsed) {
      const key = typeof entry === "string" ? entry.trim() : "";
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function serializeKeyPool(keys) {
  return JSON.stringify([...keys]);
}

// ---------------------------------------------------------------------------
// HTTP: fetchWithRetry (api.ts) — 指数退避 + 全抖动, 尊重 Retry-After
// ---------------------------------------------------------------------------

function getRetryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateValue = Date.parse(raw);
  if (Number.isFinite(dateValue)) {
    const deltaMs = dateValue - Date.now();
    return deltaMs > 0 ? deltaMs : undefined;
  }
  return undefined;
}

function calculateRetryDelay(attempt, retryAfter) {
  if (retryAfter !== undefined && retryAfter > 0) {
    const jitter = retryAfter * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.max(Math.round(retryAfter + jitter), 0), MAX_RETRY_DELAY_MS);
  }
  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  return Math.round(Math.random() * cappedDelay);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason ?? new Error("aborted"));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithRetry(url, init, retries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableStatus(response.status)) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (i < retries - 1) {
        const delay = calculateRetryDelay(i, getRetryAfterMs(response));
        await sleep(delay, init.signal);
      }
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw error;
      if (i < retries - 1) {
        const delay = calculateRetryDelay(i);
        await sleep(delay, init.signal);
      }
    }
  }
  throw lastError ?? new Error("Network request failed after retries");
}

// ---------------------------------------------------------------------------
// 模型目录 (model-catalog.ts): /models 自描述, 归一化 + 非 chat 过滤
// ---------------------------------------------------------------------------

function pickPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function deriveDisplayName(modelId) {
  const lastSegment = modelId.split("/").at(-1);
  return lastSegment && lastSegment.length > 0 ? lastSegment : modelId;
}

function normalizeModel(row) {
  if (!row || typeof row.id !== "string" || !row.id.trim()) return null;
  const id = row.id.trim();
  if (!isChatModelId(id)) return null;
  const providers = Array.isArray(row.providers) ? row.providers : [];
  const inputModalities = Array.isArray(row.architecture?.input_modalities)
    ? row.architecture.input_modalities
    : [];
  return {
    id,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : deriveDisplayName(id),
    context: pickPositiveNumber(row.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    output: DEFAULT_MAX_OUTPUT_TOKENS,
    tools: true, // 保守默认: 保持可选, 与 VS Code 扩展一致
    vision:
      providers.some((p) => p?.vision === true) ||
      inputModalities.some((m) => typeof m === "string" && m.toLowerCase().includes("image")),
    reasoning: isThinkingModel(id),
    free: row.free === true,
  };
}

function parseModels(payload) {
  // AMD 的 /models 返回裸数组; 兼容 {data:[...]} 信封 (api.ts fetchModels 同款)
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const model = normalizeModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

// ---------------------------------------------------------------------------
// 请求体改写 (streaming/openai.ts + adapters + guidance):
//   1. 剥离网关不认的参数 (stop/seed/logit_bias/logprobs/...)
//   2. system 消息排最前
//   3. kimi 系: assistant 历史补 reasoning_content 占位
//   4. thinking 模型: max_tokens 下限 16384
// ---------------------------------------------------------------------------

/** 网关白名单之外会被静默丢弃的参数 (README + streaming/openai.ts 只透传这些) */
const DROPPED_PARAMS = ["stop", "seed", "logit_bias", "logprobs", "top_logprobs", "n", "user"];

function stripDroppedParams(body) {
  let changed = false;
  for (const key of DROPPED_PARAMS) {
    if (key in body) {
      delete body[key];
      changed = true;
    }
  }
  return changed;
}

function systemFirst(messages) {
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message?.role === "system") system.push(message);
    else rest.push(message);
  }
  return [...system, ...rest];
}

function kimiReasoningWorkaround(messages) {
  let patched;
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (msg?.role !== "assistant" || msg.reasoning_content) continue;
    patched ??= [...messages];
    patched[index] = { ...msg, reasoning_content: " " };
  }
  return patched ?? messages;
}

function prefersKimiWorkaround(modelId) {
  return /(^|[\/_-])kimi([\/_-]|$)/i.test(modelId);
}

function rewriteRequestBody(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!body || typeof body !== "object") return bodyText;

  const requestedModel = typeof body.model === "string" ? body.model : "";
  let changed = stripDroppedParams(body);

  if (Array.isArray(body.messages)) {
    const reordered = systemFirst(body.messages);
    if (reordered !== body.messages) {
      body.messages = reordered;
      changed = true;
    }
    if (requestedModel && prefersKimiWorkaround(requestedModel)) {
      const patched = kimiReasoningWorkaround(body.messages);
      if (patched !== body.messages) {
        body.messages = patched;
        changed = true;
      }
    }
  }

  // thinking 模型: 推理先消耗 max_tokens 预算, 给输出留 16K 下限
  if (requestedModel && isThinkingModel(requestedModel)) {
    const current = typeof body.max_tokens === "number" ? body.max_tokens : 0;
    const floored = Math.max(current, THINKING_MIN_OUTPUT_TOKENS);
    if (floored !== current) {
      body.max_tokens = floored;
      changed = true;
    }
  }

  return changed ? JSON.stringify(body) : bodyText;
}

// ---------------------------------------------------------------------------
// 进程内目录缓存, 按 key 池内容键控
// ---------------------------------------------------------------------------

const catalogCache = new Map(); // cacheKey -> { models, fetchedAt }

function cacheKeyOf(keys) {
  return keys.join("|");
}

function cachedCatalog(keys) {
  const entry = catalogCache.get(cacheKeyOf(keys));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    catalogCache.delete(cacheKeyOf(keys));
    return null;
  }
  return entry.models;
}

async function fetchCatalog(keys) {
  const cached = cachedCatalog(keys);
  if (cached) return cached;
  const response = await fetchWithRetry(`${BASE_URL}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${keys[0]}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw gatewayError(response.status, `模型目录查询返回 HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  const models = parseModels(payload);
  if (!models.length) {
    throw gatewayError(502, "AMD TokenFactory 模型目录为空或格式不认识");
  }
  catalogCache.set(cacheKeyOf(keys), { models, fetchedAt: Date.now() });
  return models;
}

// ---------------------------------------------------------------------------
// Fleet 负载 (可选): 公开端点, 无需 key, ~25s 响应
// ---------------------------------------------------------------------------

async function fetchFleetLoad() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(LOAD_URL, { signal: controller.signal });
    if (!response.ok) {
      throw gatewayError(response.status, `负载查询返回 HTTP ${response.status}`);
    }
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

function gatewayError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function authError(message) {
  return Object.assign(new Error(message), { signIn: "expired" });
}

// ---------------------------------------------------------------------------
// 插件本体 (OpenCode v1 形态, 骨架与 loomy 插件一致)
// ---------------------------------------------------------------------------

export const AmdPlugin = async ({ client } = {}) => {
  const log = (message) => {
    try {
      void client?.app?.log?.({ body: { service: "amd", level: "info", message } })?.catch?.(() => {});
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  /** round-robin 游标 (provider.ts keyCursor) */
  let keyCursor = 0;

  const keysOf = (auth) => {
    const keys = parseKeyPool(auth?.access);
    if (!keys.length) throw authError("AMD TokenFactory 账号缺少 API key，请重新登录");
    return keys;
  };

  const pickRotatingKey = (keys) => {
    const key = keys[keyCursor % keys.length];
    keyCursor = (keyCursor + 1) % Number.MAX_SAFE_INTEGER;
    return key;
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER_ID] ?? {};
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: BASE_URL,
        ...was,
        models: {
          "deepseek-ai/deepseek-v4-flash-0731": {
            id: "deepseek-ai/deepseek-v4-flash-0731",
            name: "DeepSeek V4 Flash 0731",
            limit: { context: 1048576, output: DEFAULT_MAX_OUTPUT_TOKENS },
            reasoning: true,
            tool_call: true,
          },
          ...(was.models ?? {}),
        },
      };
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        try {
          const keys = keysOf(auth);
          const list = await fetchCatalog(keys);
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(provider, m)]));
        } catch {
          return provider.models;
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth) {
        const auth = await getAuth();
        return {
          baseURL: BASE_URL,
          apiKey: "amd-tokenfactory-key",
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null;
            const rawBody = request ? request.body : init.body;
            let bodyText = rawBody == null ? "" : typeof rawBody === "string" ? rawBody : await new Response(rawBody).text();

            let keys;
            try {
              keys = keysOf(await getAuth());
            } catch (error) {
              return signInResponse(error);
            }

            // 网关怪癖适配: 剥参数 / system 排前 / kimi 占位 / thinking 预算下限
            if (bodyText) bodyText = rewriteRequestBody(bodyText);

            const headers = new Headers(request ? request.headers : init.headers);
            for (const key of ["authorization", "x-api-key", "content-length"]) headers.delete(key);
            headers.set("Authorization", `Bearer ${pickRotatingKey(keys)}`);
            headers.set("Content-Type", "application/json");

            let response;
            try {
              response = await fetch(request ? request.url : input, {
                ...init,
                method: init.method ?? request?.method ?? "POST",
                headers,
                body: bodyText || undefined,
                signal: init.signal ?? request?.signal,
              });
            } catch (error) {
              if (init.signal?.aborted) throw error;
              throw gatewayError(502, `AMD TokenFactory 请求失败：${error?.message ?? error}`);
            }

            // key 失效/限流时换下一个 key 重试 (provider.ts isKeyFailoverError):
            // 只在响应头已到、body 未消费时重试, 避免重复输出
            if (isRetryableStatus(response.status) && keys.length > 1) {
              for (let attempt = 1; attempt < keys.length; attempt++) {
                const retryHeaders = new Headers(headers);
                retryHeaders.set("Authorization", `Bearer ${pickRotatingKey(keys)}`);
                const retryResponse = await fetch(request ? request.url : input, {
                  ...init,
                  method: init.method ?? request?.method ?? "POST",
                  headers: retryHeaders,
                  body: bodyText || undefined,
                  signal: init.signal ?? request?.signal,
                }).catch(() => null);
                if (!retryResponse) continue;
                if (isRetryableStatus(retryResponse.status)) {
                  void retryResponse.body?.cancel?.();
                  continue;
                }
                return retryResponse;
              }
            }
            return response;
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        try {
          const keys = keysOf(auth);
          const load = await fetchFleetLoad().catch(() => null);
          const summary = summarizeFleetLoad(load);
          return {
            user: auth.accountId || `AMD ${keys.length} key`,
            balance: summary ? `${summary}` : "按 key 限流 ~30 req/min",
            windows: [
              { name: "API keys", display: `${keys.length}`, amount: keys.length, unit: "个" },
              ...(summary ? [{ name: "Fleet 负载", display: summary, amount: 0, unit: "" }] : []),
            ],
          };
        } catch (error) {
          return {
            error: error?.message ?? String(error),
            signIn: error?.signIn === "expired" ? "expired" : "kept",
          };
        }
      },

      methods: [
        {
          type: "oauth",
          label: "粘贴 API key（rc- 开头，可一次粘贴多个，逗号/换行分隔）",
          prompts: [
            {
              type: "password",
              key: "keys",
              message: "AMD TokenFactory API key（developer.amd.com.cn/radeon/tokenfactory 申请）",
              placeholder: "rc-xxxxxxxx…（多个 key 用逗号或换行分隔）",
            },
            { type: "text", key: "note", message: "备注名（可选）", placeholder: "例如 主力号", validate: () => undefined },
          ],
          authorize: async (inputs) => {
            const keys = splitKeysInput(inputs?.keys);
            if (!keys.length) throw gatewayError(400, "请至少填写一个 rc- 开头的 API key");
            // 校验: 拉一次模型目录 (第一个 key)
            const response = await fetchWithRetry(`${BASE_URL}/models`, {
              method: "GET",
              headers: { Authorization: `Bearer ${keys[0]}`, "Content-Type": "application/json" },
            });
            if (!response.ok) {
              if (response.status === 401 || response.status === 403) {
                throw authError(`API key 无效或已过期（HTTP ${response.status}）`);
              }
              throw gatewayError(response.status, `key 校验失败：HTTP ${response.status}`);
            }
            const models = parseModels(await response.json().catch(() => null));
            if (!models.length) throw gatewayError(401, "key 有效但模型目录为空，请稍后重试");
            catalogCache.set(cacheKeyOf(keys), { models, fetchedAt: Date.now() });
            const note = String(inputs?.note ?? "").trim();
            const accountId =
              note || `AMD ${maskApiKey(keys[0])}${keys.length > 1 ? ` +${keys.length - 1}` : ""}`;
            log(`已配置 ${keys.length} 个 API key`);
            // magpie 宿主对 authorize 的结果统一调 callback() 取登录结果,
            // 直接返回 { type: "success" } 会炸 "callback is not a function".
            // 这里 key 已校验过, callback 直接把 success 交回去 (同 loomy 桌面端导入形态).
            return {
              url: "",
              method: "auto",
              instructions:
                keys.length > 1
                  ? `已配置 ${keys.length} 个 AMD TokenFactory API key，请求将轮换使用。`
                  : `已配置 AMD TokenFactory API key（${maskApiKey(keys[0])}）。`,
              callback: async () => ({
                type: "success",
                access: serializeKeyPool(keys),
                refresh: "",
                accountId,
              }),
            };
          },
        },
      ],
    },
  };
};

// ---------------------------------------------------------------------------
// 运行时模型映射 (loomy runtimeModel 同款形态)
// ---------------------------------------------------------------------------

function runtimeModel(provider, m) {
  const base = provider.models?.[m.id] ?? {};
  return {
    ...base,
    id: m.id,
    name: m.name || m.id,
    api: { id: m.id, url: BASE_URL, npm: "@ai-sdk/openai-compatible" },
    limit: { context: m.context ?? DEFAULT_CONTEXT_WINDOW, output: m.output ?? DEFAULT_MAX_OUTPUT_TOKENS },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.vision,
      toolcall: m.tools !== false,
      input: { text: true, image: !!m.vision, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    ...(m.free ? { free: true } : {}),
    ...(m.reasoning ? { variants: { low: {}, medium: {}, high: {} } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function splitKeysInput(raw) {
  const text = String(raw ?? "");
  const keys = [];
  for (const piece of text.split(/[\n,，;；]+/)) {
    const key = piece.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function summarizeFleetLoad(load) {
  if (!load || typeof load !== "object") return "";
  const models = Array.isArray(load.models) ? load.models : [];
  if (!models.length) return "";
  let available = 0;
  let busy = 0;
  let capacity = 0;
  let unknown = 0;
  for (const model of models) {
    const status = String(model?.status ?? "").toLowerCase();
    if (status === "available") available++;
    else if (status === "busy") busy++;
    else if (status === "at capacity" || status === "at_capacity") capacity++;
    else unknown++;
  }
  const parts = [`可用 ${available}`, `繁忙 ${busy}`, `满载 ${capacity}`];
  if (unknown) parts.push(`未知 ${unknown}`);
  return parts.join(" · ");
}

function signInResponse(error) {
  const expired = error?.signIn === "expired";
  return new Response(
    JSON.stringify({
      error: {
        message: error?.message ?? String(error),
        type: expired ? "authentication_error" : "api_error",
      },
    }),
    {
      status: expired ? 401 : 502,
      headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": expired ? "expired" : "kept" },
    },
  );
}

export const _internal = {
  isThinkingModel,
  isChatModelId,
  isRetryableStatus,
  maskApiKey,
  parseKeyPool,
  serializeKeyPool,
  getRetryAfterMs,
  calculateRetryDelay,
  normalizeModel,
  parseModels,
  stripDroppedParams,
  systemFirst,
  kimiReasoningWorkaround,
  prefersKimiWorkaround,
  rewriteRequestBody,
  splitKeysInput,
  summarizeFleetLoad,
};

export default AmdPlugin;
