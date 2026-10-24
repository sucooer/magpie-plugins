/**
 * magpie / OpenCode provider plugin: Loomy (讯飞)
 *
 * 逆向来源: agent2api (sucooer/agent2api) 的 Rust 适配器, 上游为讯飞 Loomy
 * 桌面客户端 (Electron) 的三套平面:
 *
 *   账号 CAccount     https://account.xfinfr.com
 *                     HMAC-SHA1 签名头 (客户端内置 AccessKey 对, 见 SIGN_*)
 *                     POST /login/phone/sendMsgCode
 *                     POST /login/phone/checkCode  → session (14 天, 无续期)
 *   集成网关          https://loomyad.xunfei.cn
 *                     header: token: <session> (+ Authorization: Bearer 双头)
 *   模型网关          {集成网关}/api/v1           OpenAI 兼容
 *                     GET  /models                 目录
 *                     POST /chat/completions       推理
 *                     GET  /api/v2/points/records  余额摘要
 *                     POST /api/v1/points/first-login  每日签到刷新
 *
 * 本插件纯依赖 Bun/Node 标准库 (node:crypto 做 HMAC-SHA1 / MD5 / UUID),
 * 零 npm 运行时依赖. 测试: `bun test` (见 index.test.mjs).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PROVIDER_ID = "loomy";
const PROVIDER_NAME = "Loomy";

const XFYUN_BASE = trimSlash(process.env.LOOMY_XFYUN_BASE_URL) || "https://account.xfinfr.com";
const INTEGRATION_BASE =
  trimSlash(process.env.LOOMY_POINTS_BASE_URL) || "https://loomyad.xunfei.cn";
const MODEL_BASE = `${INTEGRATION_BASE}/api/v1`;

const SIGN_ACCESS_KEY_ID = process.env.LOOMY_XFYUN_ACCESS_KEY_ID || "2thryby66wxi53sk";
const SIGN_ACCESS_KEY_SECRET =
  process.env.LOOMY_XFYUN_ACCESS_KEY_SECRET || "zsak6eadrbawz683wf5r3m2snrwj868r";
const APP_ID = process.env.LOOMY_XFYUN_APP_ID || "GM3LOOMY";

/** 会话有效期: 上游登录接口的 expire=14 天 (秒), 无续期接口 */
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
/** 目录与余额的进程内缓存 TTL (与 agent2api 的 10 分钟同档) */
const CACHE_TTL_MS = 10 * 60 * 1000;

const AUTH_ERROR_CODES = ["020002", "100002"];
const SUCCESS_CODE = "000000";

const CLIENT_MODEL_ID = "Web";
const CLIENT_DEVICE_ID = "web";
const CLIENT_UA = "Loomy|Desktop|Electron|macOS";
const CLIENT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// 桌面端登录态导入 (Windows / macOS / Linux)
//
// Loomy 是 Electron 应用, 登录态以**明文 JSON** 存在 Chromium 的 Local Storage
// (leveldb) 里, 键名 `loomy-auth-session`:
//   {"phone":…, "maskedPhone":…, "session":…, "userid":…, "loggedInAt":…}
// 无加密、无 DPAPI —— 与 agent2api 逆向 macOS 客户端得到的结论不同: 那里
// 只确认了「没有稳定的 auth.json 形态」, 没说 leveldb 里的明文不可读.
// 实测 (Loomy 0.9.39, Windows): %APPDATA%\Loomy\Local Storage\leveldb\
// 000003.log 内可直接读出 session, 且该 session 能打通 /api/v1/models 与
// /api/v2/points/records —— 即"导入"是可靠路径, 不必走短信.
// ---------------------------------------------------------------------------

const DESKTOP_SESSION_KEY = "loomy-auth-session";

function desktopStorageDirs() {
  const home = homedir();
  const dirs = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    dirs.push(path.join(appData, "Loomy", "Local Storage", "leveldb"));
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "Loomy", "Local Storage", "leveldb"));
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    dirs.push(path.join(cfg, "Loomy", "Local Storage", "leveldb"));
  }
  return dirs;
}

/** 从一段字节里取 key 之后的完整 JSON 对象 (括号配对, 容错截断) */
function jsonAfter(bytes, from) {
  const open = bytes.indexOf(0x7b, from); // "{"
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x22) {
      // 跳过字符串字面量, 括号配对不受字符串内容干扰
      i++;
      while (i < bytes.length && bytes[i] !== 0x22) {
        if (bytes[i] === 0x5c) i++; // 反斜杠转义
        i++;
      }
      continue;
    }
    if (byte === 0x7b) depth++;
    else if (byte === 0x7d && --depth === 0) {
      try {
        return JSON.parse(bytes.subarray(open, i + 1).toString("utf8"));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 在 leveldb 的 .log 文件里找 `loomy-auth-session` 的值.
 * leveldb 的 log 是追加写的, 同一个键可能有多份 (新的在后), 因此**从后往前**
 * 找, 拿到的是最近一次写入 —— 即当前登录态.
 */
function readDesktopSessionFrom(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const logs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => entry.name)
    .sort();
  for (const name of logs.reverse()) {
    let bytes;
    try {
      bytes = readFileSync(path.join(dir, name));
    } catch {
      continue;
    }
    const key = new TextEncoder().encode(DESKTOP_SESSION_KEY);
    let at = bytes.lastIndexOf(key);
    while (at >= 0) {
      const value = jsonAfter(bytes, at + key.length);
      if (value && typeof value.session === "string" && value.session.trim()) return value;
      at = bytes.lastIndexOf(key, at - 1);
    }
  }
  return null;
}

/** 读本机 Loomy 桌面端登录态; 没有返回 null */
function readDesktopSession() {
  for (const dir of desktopStorageDirs()) {
    const value = readDesktopSessionFrom(dir);
    if (value) return value;
  }
  return null;
}

function trimSlash(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

// ---------------------------------------------------------------------------
// HMAC-SHA1 请求签名 (复刻 agent2api loomy/sign.rs, 客户端 generateSignature)
// 待签串 9 段 \n 连接:
//   METHOD\n ESCAPED_PATH\n ""(query)\n CONTENT_MD5\n content-type\n
//   DATE(UTC)\n NONCE(UUID v4)\n ""(signed headers)\n ""(canonicalized headers)
// 当前账号接口路径只含字母与 /, 转义即原串, 仍实现完整规则以免将来静默出错.
// ---------------------------------------------------------------------------

function escapePathSegment(segment) {
  let out = "";
  for (const byte of new TextEncoder().encode(segment)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function buildEscapedPath(path) {
  let clean = path.startsWith("/") ? path : "/" + path;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean.split("/").map(escapePathSegment).join("/");
}

function utcDateString() {
  return new Date().toUTCString(); // Sun, 06 Oct 2026 12:34:56 GMT
}

function contentMd5Base64(bodyString) {
  if (!bodyString) return "";
  return createHash("md5").update(bodyString, "utf8").digest("base64");
}

function signedHeaders(method, path, bodyString) {
  const md5 = contentMd5Base64(bodyString);
  const date = utcDateString();
  const nonce = randomUUID(); // 客户端用 crypto.randomUUID() 原样值
  const stringToSign = [
    method.toUpperCase(),
    buildEscapedPath(path),
    "",
    md5,
    "application/json",
    date,
    nonce,
    "",
    "",
  ].join("\n");
  const signature = createHmac("sha1", SIGN_ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("base64");
  const headers = {
    Authorization: `account ${SIGN_ACCESS_KEY_ID}:${signature}`,
    Date: date,
    Nonce: nonce,
  };
  if (md5) headers["Content-MD5"] = md5;
  return headers;
}

// ---------------------------------------------------------------------------
// 账号 (CAccount) 请求: 带签名的 POST, 信封 {base, param}
// ---------------------------------------------------------------------------

function makeBase() {
  return {
    appid: APP_ID,
    modelid: CLIENT_MODEL_ID,
    version: CLIENT_VERSION,
    devid: CLIENT_DEVICE_ID,
    ua: CLIENT_UA,
    traceid: randomUUID().replace(/-/g, ""),
  };
}

async function signedPost(path, param, what) {
  const body = JSON.stringify({ base: makeBase(), param });
  const headers = signedHeaders("POST", path, body);
  let res;
  try {
    res = await fetch(XFYUN_BASE + path, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
  } catch (error) {
    throw gatewayError(502, `${what}失败：${error?.message ?? error}`);
  }
  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    throw gatewayError(res.status, `${what}返回 HTTP ${res.status}`);
  }
  return payload ?? {};
}

function businessCode(payload) {
  return typeof payload?.code === "string" ? payload.code.trim() : "";
}

function upstreamMessage(payload) {
  const text = payload?.desc ?? payload?.message;
  return typeof text === "string" ? text.trim() : "";
}

function isAuthErrorCode(code) {
  return AUTH_ERROR_CODES.includes(code);
}

/** 业务码不是 000000 时抛出; 登录态失效归 401 并带 signIn: "expired" */
function ensureSuccess(payload, what) {
  const code = businessCode(payload);
  if (code === SUCCESS_CODE) return;
  const message = upstreamMessage(payload);
  const detail = message ? `${what}：${message}` : `${what}失败（上游 code=${code}）`;
  if (isAuthErrorCode(code)) throw signInExpired(detail);
  throw gatewayError(502, detail);
}

function signInExpired(message) {
  return Object.assign(new Error(message), { signIn: "expired" });
}

function gatewayError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizePhone(raw) {
  const trimmed = String(raw ?? "")
    .replace(/[\s-]/g, "")
    .replace(/^\+86/, "");
  const digits = /^86\d{11}$/.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (/^1[3-9]\d{9}$/.test(digits)) return digits;
  throw gatewayError(400, "请填写 11 位中国大陆手机号");
}

function normalizeCode(raw) {
  const trimmed = String(raw ?? "").trim();
  if (/^\d{6}$/.test(trimmed)) return trimmed;
  throw gatewayError(400, "请填写 6 位数字验证码");
}

function extractMsgid(payload) {
  const candidates = [
    payload?.data?.msgid,
    payload?.data?.msgId,
    payload?.data?.data?.msgid,
    payload?.data?.data?.msgId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function extractSessionUserid(payload) {
  const data = payload?.data ?? {};
  const session = typeof data.session === "string" ? data.session.trim() : "";
  const userid = typeof data.userid === "string" ? data.userid.trim() : "";
  return { session, userid };
}

// ---------------------------------------------------------------------------
// 集成网关请求: token 双头 (token + Authorization: Bearer)
// ---------------------------------------------------------------------------

function sessionOf(auth) {
  return typeof auth?.access === "string" ? auth.access.trim() : "";
}

function assertSession(auth) {
  const session = sessionOf(auth);
  if (!session) throw signInExpired("Loomy 账号缺少 session，请重新登录");
  return session;
}

function integrationHeaders(session) {
  return {
    token: session,
    Authorization: `Bearer ${session}`,
  };
}

async function tokenRequest(method, pathAndQuery, session, body, what) {
  const headers = integrationHeaders(assertSessionValue(session));
  let res;
  try {
    res = await fetch(INTEGRATION_BASE + pathAndQuery, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw gatewayError(502, `${what}失败：${error?.message ?? error}`);
  }
  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    throw gatewayError(res.status, `${what}返回 HTTP ${res.status}`);
  }
  return payload ?? {};
}

function assertSessionValue(session) {
  if (!session || !String(session).trim()) throw signInExpired("Loomy 账号缺少 session");
  return String(session).trim();
}

// ---------------------------------------------------------------------------
// 模型目录: GET {模型网关}/models (OpenAI 形态 {data: [...]})
// 能力位读上游 capabilities: reasoning / function_calling / vision /
// input_modalities; 上下文与输出上限按客户端 normalizeFetchedModelMetadata
// 的一手键名逐个试; 倍率从展示名尾部 (x3.0) 括号拆出.
// ---------------------------------------------------------------------------

const FALLBACK_MODEL = {
  id: "spark-x",
  name: "Spark X",
  limit: { context: 131072, output: 8192 },
  reasoning: true,
  tool_call: true,
};

function pickNumber(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function capsBool(caps, key) {
  return caps?.[key] === true;
}

function capsModal(caps, modal) {
  const items = caps?.input_modalities;
  return Array.isArray(items) && items.some((v) => typeof v === "string" && v.toLowerCase() === modal);
}

function isReasoningModel(id) {
  return id.toLowerCase().includes("spark-x");
}

/** 从展示名尾部拆 (x3.0) / （x0.8）形态的积分倍率; 其余标签原样保留 */
function splitRateSuffix(name) {
  const trimmed = name.trimEnd();
  let body = null;
  let inner = "";
  if (trimmed.endsWith(")")) {
    const open = trimmed.lastIndexOf("(");
    if (open < 0) return [name, undefined];
    body = trimmed.slice(0, open);
    inner = trimmed.slice(open + 1, -1).trim();
  } else if (trimmed.endsWith("）")) {
    const open = trimmed.lastIndexOf("（");
    if (open < 0) return [name, undefined];
    body = trimmed.slice(0, open);
    inner = trimmed.slice(open + 1, -1).trim();
  } else {
    return [name, undefined];
  }
  const number = /^[xX]([\d.]+)$/.exec(inner)?.[1];
  if (!number || !/\d/.test(number)) return [name, undefined];
  const cleaned = body.trimEnd();
  const rate = `x${number}`;
  return [cleaned || name, rate];
}

function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const models = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
    const id = row.id.trim();
    const rawName = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
    const [name, rate] = splitRateSuffix(rawName);
    const caps = row.capabilities && typeof row.capabilities === "object" ? row.capabilities : undefined;
    const context = pickNumber(row, [
      "context_length",
      "context_window",
      "input_token_limit",
      "max_input_tokens",
      "maxInputTokens",
    ]);
    const output = pickNumber(row, [
      "max_output_tokens",
      "max_completion_tokens",
      "max_tokens",
      "maxOutputTokens",
    ]);
    models.push({
      id,
      name,
      context,
      output,
      reasoning: capsBool(caps, "reasoning") || (!caps && isReasoningModel(id)),
      tool_call: capsBool(caps, "function_calling") || !caps,
      images: capsBool(caps, "vision") || capsModal(caps, "image"),
      video: capsModal(caps, "video"),
      rate,
    });
  }
  return models;
}

function runtimeModel(provider, m) {
  const base = provider.models?.[m.id] ?? FALLBACK_SHAPE;
  const model = {
    ...base,
    id: m.id,
    name: m.name || m.id,
    api: { id: m.id, url: MODEL_BASE, npm: "@ai-sdk/openai-compatible" },
    limit: { context: m.context ?? base.limit?.context ?? 0, output: m.output ?? base.limit?.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      toolcall: m.tool_call !== false,
      input: { text: true, image: !!m.images, audio: false, video: !!m.video, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: m.reasoning ? { low: {}, medium: {}, high: {} } : {},
  };
  if (m.rate) {
    model.rate = m.rate;
    model.free = false;
  }
  return model;
}

const FALLBACK_SHAPE = {
  id: "",
  name: "",
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, output: 0 },
};

// ---------------------------------------------------------------------------
// 进程内缓存 (模型目录), 按账号 session 键控
// ---------------------------------------------------------------------------

const catalogCache = new Map(); // session -> { models, fetchedAt }

function cachedCatalog(session) {
  const entry = catalogCache.get(session);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    catalogCache.delete(session);
    return null;
  }
  return entry.models;
}

async function fetchCatalog(session) {
  const cached = cachedCatalog(session);
  if (cached) return cached;
  const payload = await tokenRequest("GET", "/api/v1/models", session, undefined, "模型目录查询");
  const models = parseModels(payload);
  if (!models.length) {
    throw gatewayError(502, "Loomy 模型目录为空或格式不认识");
  }
  catalogCache.set(session, { models, fetchedAt: Date.now() });
  return models;
}

// ---------------------------------------------------------------------------
// deepseek 系模型的图片格式适配 (复刻 agent2api loomy/images.rs, 有实测依据):
//   - GLM-5.3-Flash 等: 标准 image_url data URI
//   - deepseek-v4-flash-0731 等 deepseek 系: 只认 <image_base64> 标记,
//     喂 image_url 会被上游当截断的 base64 文本读
// 宁可不转不能转错. 标记并入相邻 text 块 (上游实测认可的形态).
// ---------------------------------------------------------------------------

function prefersTagFormat(model) {
  return model.toLowerCase().includes("deepseek");
}

function toTagText(block) {
  if (!block || block.type !== "image_url") return null;
  const url = block.image_url?.url;
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  return `<image_base64>${url.slice(comma + 1)}</image_base64>`;
}

function hasConvertibleImage(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) =>
    Array.isArray(message?.content) && message.content.some((block) => toTagText(block) !== null),
  );
}

function rewriteImagesToTags(body) {
  if (!hasConvertibleImage(body)) return body;
  const next = JSON.parse(JSON.stringify(body));
  for (const message of next.messages) {
    if (!Array.isArray(message.content)) continue;
    const content = message.content;
    for (let index = content.length - 1; index >= 0; index--) {
      const tag = toTagText(content[index]);
      if (tag === null) continue;
      content.splice(index, 1);
      const previous = index > 0 ? content[index - 1] : null;
      if (previous && previous.type === "text" && typeof previous.text === "string") {
        previous.text += "\n" + tag;
      } else if (content[index] && content[index].type === "text" && typeof content[index].text === "string") {
        content[index].text = tag + "\n" + content[index].text;
      } else {
        content.splice(index, 0, { type: "text", text: tag });
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 余额: GET /api/v2/points/records 的摘要字段 (Loomy 没有独立余额接口,
// 客户端积分详情页读的就是这个 V2 流水接口里的 balance / dailyBalance).
// ---------------------------------------------------------------------------

function pickAmount(data, key) {
  const value = data?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function queryBalance(session) {
  const payload = await tokenRequest(
    "GET",
    "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat",
    session,
    undefined,
    "积分查询",
  );
  ensureSuccess(payload, "积分查询");
  // 摘要可能在 data 或 data.data 两层 (不同版本出现过两种形态)
  const data = payload?.data?.data ?? payload?.data ?? {};
  return {
    permanent: pickAmount(data, "balance"),
    daily: pickAmount(data, "dailyBalance"),
  };
}

// ---------------------------------------------------------------------------
// 插件本体 (OpenCode v1 形态: async (input, options) => hooks)
// ---------------------------------------------------------------------------

export const LoomyPlugin = async ({ client } = {}) => {
  const log = (message) => {
    try {
      void client?.app?.log?.({ body: { service: "loomy", level: "info", message } })?.catch?.(() => {});
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER_ID] ?? {};
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: MODEL_BASE,
        ...was,
        models: {
          [FALLBACK_MODEL.id]: {
            id: FALLBACK_MODEL.id,
            name: FALLBACK_MODEL.name,
            limit: { context: FALLBACK_MODEL.limit.context, output: FALLBACK_MODEL.limit.output },
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
        const session = sessionOf(auth);
        if (!session) return provider.models;
        try {
          const list = await fetchCatalog(session);
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
        if (auth?.type !== "oauth") return {};
        return {
          baseURL: MODEL_BASE,
          apiKey: "loomy-session",
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null;
            const rawBody = request ? request.body : init.body;
            let bodyText = rawBody == null ? "" : typeof rawBody === "string" ? rawBody : await new Response(rawBody).text();
            let requestedModel = "";
            try {
              requestedModel = JSON.parse(bodyText)?.model ?? "";
            } catch {
              /* 非 JSON body 不解析 */
            }

            let session;
            try {
              session = assertSession(await getAuth());
            } catch (error) {
              return signInResponse(error);
            }

            // deepseek 系: image_url data URI → <image_base64> 标记
            if (requestedModel && prefersTagFormat(requestedModel) && bodyText) {
              try {
                const parsed = JSON.parse(bodyText);
                const rewritten = rewriteImagesToTags(parsed);
                if (rewritten !== parsed) bodyText = JSON.stringify(rewritten);
              } catch {
                /* body 不是 JSON 时保持原样 */
              }
            }

            const headers = new Headers(request ? request.headers : init.headers);
            for (const key of ["authorization", "x-api-key", "token", "content-length"]) headers.delete(key);
            const credential = integrationHeaders(session);
            headers.set("token", credential.token);
            headers.set("Authorization", credential.Authorization);
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
              throw gatewayError(502, `Loomy 请求失败：${error?.message ?? error}`);
            }

            // 上游部分错误是 HTTP 200 + {code:"100002"} 信封: 只有 JSON
            // (非流式) 响应才解析, SSE 一律原样透传 (解析 clone 会把整条流缓冲住)
            const contentType = (response.headers.get("content-type") || "").toLowerCase();
            if (contentType.includes("application/json")) {
              const payload = await response.clone().json().catch(() => null);
              if (isAuthErrorCode(businessCode(payload))) {
                const headersOut = new Headers(response.headers);
                headersOut.set("X-Magpie-Sign-In", "expired");
                return new Response(response.body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: headersOut,
                });
              }
            }
            return response;
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth") return { error: "未登录" };
        try {
          const { permanent, daily } = await queryBalance(assertSession(auth));
          return {
            user: auth.accountId || auth.phone || "",
            balance: `${permanent + daily} 积分`,
            windows: [
              { name: "永久积分", display: `${permanent}`, amount: permanent, unit: "积分" },
              { name: "每日赠送积分", display: `${daily}`, amount: daily, unit: "积分" },
            ],
          };
        } catch (error) {
          return {
            error: error?.message ?? String(error),
            signIn: error?.signIn === "expired" ? "expired" : "kept",
          };
        }
      },

      async checkin(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth") return { outcome: "failed", message: "not signed in" };
        try {
          const payload = await tokenRequest("POST", "/api/v1/points/first-login", assertSession(auth), {}, "每日签到");
          ensureSuccess(payload, "每日签到");
          return { outcome: "success", message: "每日赠送积分已刷新" };
        } catch (error) {
          return { outcome: "failed", message: error?.message ?? String(error) };
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Loomy 桌面端登录态（自动读取本机客户端）",
          prompts: [],
          authorize: async () => {
            const desktop = readDesktopSession();
            if (!desktop) {
              return {
                type: "failed",
                error: "没有读到本机 Loomy 桌面端的登录态：请先打开 Loomy 客户端并登录，或用手机号 / 粘贴 session 的方式。",
              };
            }
            // 只校验一次: 导入的 session 可能已过期 (客户端未退出时它是活的)
            let models = [];
            try {
              models = parseModels(
                await tokenRequest("GET", "/api/v1/models", desktop.session, undefined, "登录校验"),
              );
            } catch (error) {
              return { type: "failed", error: error?.message ?? String(error) };
            }
            if (!models.length) {
              return { type: "failed", error: "桌面端登录态已失效：请在 Loomy 客户端重新登录后重试。" };
            }
            catalogCache.set(desktop.session, { models, fetchedAt: Date.now() });
            const masked = typeof desktop.maskedPhone === "string" && desktop.maskedPhone.trim()
              ? desktop.maskedPhone.trim()
              : desktop.phone
                ? maskPhone(String(desktop.phone))
                : "Loomy";
            // 返回对象必须带 callback: magpie 宿主对 authorize 的结果统一调
            // callback() 完成登录 (kimi-desktop 的桌面端导入同款形态).
            // 这里一次拿全, callback 直接把 success 交回去.
            return {
              url: "",
              method: "auto",
              instructions: `已从本机 Loomy 客户端导入登录态（${masked}）。`,
              callback: async () => ({
                type: "success",
                access: desktop.session,
                refresh: "",
                expires: Date.now() + SESSION_TTL_MS,
                accountId: masked,
                ...(desktop.userid ? { uid: String(desktop.userid) } : {}),
                ...(desktop.phone ? { phone: String(desktop.phone) } : {}),
                source: "desktop",
              }),
            };
          },
        },
        {
          type: "oauth",
          label: "手机号 + 短信验证码登录（输入手机号后自动发送验证码）",
          prompts: [
            { type: "text", key: "phone", message: "手机号（中国大陆 11 位）", placeholder: "13800000000" },
          ],
          authorize: async (inputs) => {
            const phone = normalizePhone(inputs?.phone);
            const payload = await signedPost(
              "/login/phone/sendMsgCode",
              { ccode: "86", phone, expire: 300 },
              "发送验证码",
            );
            ensureSuccess(payload, "发送验证码");
            const msgid = extractMsgid(payload);
            if (!msgid) throw gatewayError(502, "验证码已发出但上游没有返回 msgid");
            log(`验证码已发送（尾号 ${phone.slice(-4)}）`);
            return {
              url: "",
              method: "code",
              instructions: `验证码已发送至 ${maskPhone(phone)}，输入 6 位验证码完成登录（session 有效期 14 天）。`,
              callback: async (code) => loginWithCode(phone, code, msgid),
            };
          },
        },
        {
          type: "oauth",
          label: "粘贴 session（Loomy 客户端登录态）",
          prompts: [
            {
              type: "password",
              key: "session",
              message: "Loomy session（同时是模型网关的 token）",
              placeholder: "粘贴 session 字符串",
            },
            { type: "text", key: "phone", message: "备注名（可选）", placeholder: "例如 138****0000", validate: () => undefined },
          ],
          authorize: async (inputs) => {
            const session = String(inputs?.session ?? "").trim();
            if (!session) throw gatewayError(400, "请粘贴 session");
            // 校验 session 可用: 拉一次模型目录
            const payload = await tokenRequest("GET", "/api/v1/models", session, undefined, "登录校验");
            const models = parseModels(payload);
            if (!models.length) throw gatewayError(401, "session 无效或已过期");
            catalogCache.set(session, { models, fetchedAt: Date.now() });
            const note = String(inputs?.phone ?? "").trim();
            return {
              type: "success",
              access: session,
              refresh: "",
              expires: Date.now() + SESSION_TTL_MS,
              accountId: note || `Loomy ${session.slice(-6)}`,
            };
          },
        },
      ],
    },
  };
};

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

async function loginWithCode(phone, code, msgid) {
  const payload = await signedPost(
    "/login/phone/checkCode",
    { ccode: "86", phone, mcode: normalizeCode(code), msgid, expire: 14 * 24 * 3600 },
    "登录",
  );
  ensureSuccess(payload, "登录");
  const { session, userid } = extractSessionUserid(payload);
  if (!session) throw gatewayError(502, "登录成功但上游没有返回 session");
  return {
    type: "success",
    access: session,
    refresh: "",
    expires: Date.now() + SESSION_TTL_MS,
    accountId: maskPhone(phone),
    uid: userid,
    phone,
  };
}

function maskPhone(phone) {
  const chars = [...phone];
  if (chars.length < 7) return phone;
  return `${chars.slice(0, 3).join("")}****${chars.slice(-4).join("")}`;
}

export const _internal = {
  buildEscapedPath,
  contentMd5Base64,
  signedHeaders,
  desktopStorageDirs,
  readDesktopSession,
  readDesktopSessionFrom,
  splitRateSuffix,
  parseModels,
  prefersTagFormat,
  rewriteImagesToTags,
  normalizePhone,
  maskPhone,
};

export default LoomyPlugin;
