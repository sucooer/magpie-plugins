/**
 * 单元测试: `node --test` (纯函数, 不打上游; Node >= 18 内置测试器, 零依赖).
 * 若本机有 bun 也可用 `bun test` 跑 loomy 同款, 断言语义一致.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "./index.mjs";

describe("isThinkingModel", () => {
  test("thinking 家族命中", () => {
    assert.equal(_internal.isThinkingModel("deepseek-ai/deepseek-v4-flash-0731"), true);
    assert.equal(_internal.isThinkingModel("moonshotai/kimi-k3"), true);
    assert.equal(_internal.isThinkingModel("z-ai/glm-5.2"), true);
    assert.equal(_internal.isThinkingModel("openai/gpt-oss-120b"), true);
    assert.equal(_internal.isThinkingModel("qwen/qwq-32b"), true);
  });
  test("非 thinking 不命中", () => {
    assert.equal(_internal.isThinkingModel("meta/llama-3.3-70b-instruct"), false);
    assert.equal(_internal.isThinkingModel("deepseek-ai/deepseek-v3"), false);
  });
});

describe("isChatModelId", () => {
  test("embedding / rerank / guard / base 模型被过滤", () => {
    assert.equal(_internal.isChatModelId("nvidia/nv-embedqa-e5-v5"), false);
    assert.equal(_internal.isChatModelId("baai/bge-m3"), false);
    assert.equal(_internal.isChatModelId("nvidia/nemoguard"), false);
    assert.equal(_internal.isChatModelId("bigcode/starcoder2"), false);
    assert.equal(_internal.isChatModelId("meta/llama2-70b"), false);
  });
  test("chat 模型保留", () => {
    assert.equal(_internal.isChatModelId("deepseek-ai/deepseek-v4-flash-0731"), true);
    assert.equal(_internal.isChatModelId("meta/llama-3.3-70b-instruct"), true);
  });
});

describe("key 池", () => {
  test("JSON 数组解析 + 去重 + 去空白", () => {
    assert.deepEqual(_internal.parseKeyPool('["rc-aaa", "rc-bbb", "rc-aaa", " "]'), ["rc-aaa", "rc-bbb"]);
  });
  test("裸字符串按单 key 兼容 (legacy 迁移)", () => {
    assert.deepEqual(_internal.parseKeyPool("rc-single"), ["rc-single"]);
  });
  test("空值与坏 JSON 返回空数组", () => {
    assert.deepEqual(_internal.parseKeyPool(""), []);
    assert.deepEqual(_internal.parseKeyPool("[broken"), []);
  });
  test("序列化往返", () => {
    assert.deepEqual(_internal.parseKeyPool(_internal.serializeKeyPool(["rc-a", "rc-b"])), ["rc-a", "rc-b"]);
  });
});

describe("maskApiKey", () => {
  test("长 key 保留头尾", () => {
    assert.equal(_internal.maskApiKey("rc-35c3abcdef1234"), "rc-35c3…1234");
  });
  test("短 key 全掩码", () => {
    assert.equal(_internal.maskApiKey("rc-short"), "••••••••");
  });
});

describe("getRetryAfterMs", () => {
  test("秒数形态", () => {
    const res = new Response("", { headers: { "retry-after": "5" } });
    assert.equal(_internal.getRetryAfterMs(res), 5000);
  });
  test("无头返回 undefined", () => {
    assert.equal(_internal.getRetryAfterMs(new Response("")), undefined);
  });
});

describe("calculateRetryDelay", () => {
  test("Retry-After 优先且带 ±25% 抖动", () => {
    for (let i = 0; i < 20; i++) {
      const delay = _internal.calculateRetryDelay(0, 1000);
      assert.ok(delay >= 750 && delay <= 1250, `delay=${delay}`);
    }
  });
  test("指数退避封顶 30s", () => {
    for (let i = 0; i < 20; i++) {
      const delay = _internal.calculateRetryDelay(10);
      assert.ok(delay <= 30000, `delay=${delay}`);
    }
  });
});

describe("parseModels / normalizeModel", () => {
  const sample = [
    {
      id: "deepseek-ai/deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash 0731",
      context_length: 1048576,
      providers: [{ vision: false }],
      free: true,
    },
    { id: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3", context_length: 1048576, providers: [{ vision: true }] },
    { id: "deepseek-ai/deepseek-v4-flash-0731", name: "dup" },
  ];

  test("裸数组形态: 过滤非 chat + 去重 + 能力位", () => {
    const models = _internal.parseModels(sample);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "deepseek-ai/deepseek-v4-flash-0731");
    assert.equal(models[0].context, 1048576);
    assert.equal(models[0].reasoning, true);
    assert.equal(models[0].free, true);
    assert.equal(models[1].vision, true);
  });

  test("{data:[...]} 信封兼容", () => {
    const models = _internal.parseModels({ data: sample });
    assert.equal(models.length, 2);
  });

  test("缺 context_length 用默认 131072", () => {
    const models = _internal.parseModels([{ id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" }]);
    assert.equal(models[0].context, 131072);
  });

  test("input_modalities 含 image 也算 vision", () => {
    const models = _internal.parseModels([
      { id: "x/vlm-1", name: "VLM", architecture: { input_modalities: ["text", "image"] } },
    ]);
    assert.equal(models[0].vision, true);
  });
});

describe("rewriteRequestBody", () => {
  test("剥离网关丢弃的参数", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(JSON.stringify({ model: "m", stop: ["\n"], seed: 1, logit_bias: {}, messages: [] })),
    );
    assert.equal(out.stop, undefined);
    assert.equal(out.seed, undefined);
    assert.equal(out.logit_bias, undefined);
  });

  test("system 消息排最前", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(
        JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "system", content: "sys" }] }),
      ),
    );
    assert.equal(out.messages[0].role, "system");
  });

  test("kimi 系 assistant 历史补 reasoning_content 占位", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(
        JSON.stringify({
          model: "moonshotai/kimi-k3",
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
          ],
        }),
      ),
    );
    const assistant = out.messages.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, " ");
  });

  test("非 kimi 模型不动 assistant", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(
        JSON.stringify({
          model: "meta/llama-3.3-70b-instruct",
          messages: [{ role: "assistant", content: "a" }],
        }),
      ),
    );
    assert.equal(out.messages[0].reasoning_content, undefined);
  });

  test("thinking 模型 max_tokens 下限 16384", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(JSON.stringify({ model: "z-ai/glm-5.2", max_tokens: 2048, messages: [] })),
    );
    assert.equal(out.max_tokens, 16384);
  });

  test("非 thinking 模型不动 max_tokens", () => {
    const out = JSON.parse(
      _internal.rewriteRequestBody(JSON.stringify({ model: "meta/llama-3.3-70b-instruct", max_tokens: 2048, messages: [] })),
    );
    assert.equal(out.max_tokens, 2048);
  });

  test("无需改动时原样返回 (字符串相等)", () => {
    const text = JSON.stringify({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hi" }] });
    assert.equal(_internal.rewriteRequestBody(text), text);
  });

  test("坏 JSON 原样返回", () => {
    assert.equal(_internal.rewriteRequestBody("not-json"), "not-json");
  });
});

describe("splitKeysInput", () => {
  test("逗号/换行/中文逗号分隔 + 去重", () => {
    assert.deepEqual(_internal.splitKeysInput("rc-a\nrc-b，rc-c, rc-a"), ["rc-a", "rc-b", "rc-c"]);
  });
  test("空白返回空数组", () => {
    assert.deepEqual(_internal.splitKeysInput("  "), []);
  });
});

describe("summarizeFleetLoad", () => {
  test("按状态分组", () => {
    const summary = _internal.summarizeFleetLoad({
      models: [{ status: "available" }, { status: "busy" }, { status: "at capacity" }, { status: "weird" }],
    });
    assert.equal(summary, "可用 1 · 繁忙 1 · 满载 1 · 未知 1");
  });
  test("空负载返回空串", () => {
    assert.equal(_internal.summarizeFleetLoad(null), "");
    assert.equal(_internal.summarizeFleetLoad({}), "");
  });
});
