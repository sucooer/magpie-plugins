/**
 * 单元测试: `bun test` (纯函数, 不打上游).
 */
import { describe, expect, test } from "bun:test";
import { _internal } from "./index.mjs";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("buildEscapedPath", () => {
  test("加前导斜杠并去尾部斜杠", () => {
    expect(_internal.buildEscapedPath("login/phone/sendMsgCode/")).toBe("/login/phone/sendMsgCode");
    expect(_internal.buildEscapedPath("/a//b")).toBe("/a//b");
  });
});

describe("contentMd5Base64", () => {
  test("空串返回空串", () => {
    expect(_internal.contentMd5Base64("")).toBe("");
  });
  test("已知向量", () => {
    expect(_internal.contentMd5Base64("hello")).toBe("XUFAKrxLKna5cZ2REBfFkg==");
  });
});

describe("signedHeaders", () => {
  test("四件套齐全且 Authorization 带 account 前缀", () => {
    const headers = _internal.signedHeaders("POST", "/login/phone/checkCode", '{"a":1}');
    expect(headers.Authorization).toMatch(/^account 2thryby66wxi53sk:[A-Za-z0-9+/=]+$/);
    expect(headers["Content-MD5"]).toBeTruthy();
    expect(headers.Date).toMatch(/GMT$/);
    expect(headers.Nonce).toMatch(/^[0-9a-f-]{36}$/);
  });
  test("无 body 时没有 Content-MD5", () => {
    const headers = _internal.signedHeaders("POST", "/x", "");
    expect(headers["Content-MD5"]).toBeUndefined();
  });
});

describe("splitRateSuffix", () => {
  test("ASCII 括号倍率", () => {
    expect(_internal.splitRateSuffix("DeepSeek V4 Flash 0731 (x3.0)")).toEqual([
      "DeepSeek V4 Flash 0731",
      "x3.0",
    ]);
  });
  test("全角括号倍率", () => {
    expect(_internal.splitRateSuffix("GLM 5.3 Flash（x0.8）")).toEqual(["GLM 5.3 Flash", "x0.8"]);
  });
  test("非倍率标签原样保留", () => {
    expect(_internal.splitRateSuffix("Spark X2.5（限时免费）")).toEqual([
      "Spark X2.5（限时免费）",
      undefined,
    ]);
  });
});

describe("parseModels", () => {
  test("OpenAI 形态 + capabilities 映射", () => {
    const list = _internal.parseModels({
      data: [
        {
          id: "spark-x",
          name: "Spark X2.5 (x0.1)",
          context_length: 131072,
          max_output_tokens: 8192,
          capabilities: { reasoning: true, function_calling: true, vision: true, input_modalities: ["text", "image"] },
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "spark-x",
      name: "Spark X2.5",
      rate: "x0.1",
      context: 131072,
      output: 8192,
      reasoning: true,
      tool_call: true,
      images: true,
    });
  });
  test("缺 capabilities 时按 id 兜底思考位", () => {
    const list = _internal.parseModels({ data: [{ id: "spark-x" }] });
    expect(list[0].reasoning).toBe(true);
    expect(list[0].tool_call).toBe(true);
  });
  test("裸数组形态与非法条目", () => {
    const list = _internal.parseModels([{ id: "a" }, { name: "no-id" }, null]);
    expect(list.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("rewriteImagesToTags (deepseek 图片适配)", () => {
  test("image_url data URI 并入前一个 text 块", () => {
    const body = {
      model: "deepseek-v4-flash-0731",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          ],
        },
      ],
    };
    const out = _internal.rewriteImagesToTags(body);
    expect(out.messages[0].content).toEqual([{ type: "text", text: "看图\n<image_base64>QUJD</image_base64>" }]);
    expect(body.messages[0].content).toHaveLength(2); // 不改原对象
  });
  test("没有前块时并入后块", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
            { type: "text", text: "这是什么" },
          ],
        },
      ],
    };
    const out = _internal.rewriteImagesToTags(body);
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "<image_base64>QUJD</image_base64>\n这是什么" },
    ]);
  });
  test("无图片时不拷贝", () => {
    const body = { messages: [{ role: "user", content: "纯文本" }] };
    expect(_internal.rewriteImagesToTags(body)).toBe(body);
  });
  test("http 图片链接不转", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }],
    };
    expect(_internal.rewriteImagesToTags(body)).toBe(body);
  });
});

describe("normalizePhone / maskPhone", () => {
  test("容忍 +86 / 86 前缀与连字符空格", () => {
    expect(_internal.normalizePhone("+86 138-0000-0000")).toBe("13800000000");
    expect(_internal.normalizePhone("8613800000000")).toBe("13800000000");
  });
  test("非法手机号", () => {
    expect(() => _internal.normalizePhone("123")).toThrow();
    expect(() => _internal.normalizePhone("23800000000")).toThrow();
  });
  test("脱敏", () => {
    expect(_internal.maskPhone("13800000000")).toBe("138****0000");
  });
});

describe("readDesktopSessionFrom (leveldb 解析)", () => {
  // 真实日志的形态: 键名前有 _file://\x00\x01, 值紧跟一个 0x01 类型标记,
  // JSON 之后是下一个键. 同一文件里可能有多个版本的同一键.
  const log = (session, phone) =>
    Buffer.concat([
      Buffer.from("_file://\x00\x01loomy-auth-session"),
      Buffer.from([0x01]),
      Buffer.from(
        JSON.stringify({
          phone,
          maskedPhone: "198****3408",
          session,
          userid: "261018152353105151",
          loggedInAt: "2026-10-18T07:23:53.073Z",
        }),
      ),
      Buffer.from("\x01 _file://\x00\x01loomy-last-login-phone\x0c\x0119808203408"),
    ]);

  test("从 leveldb 日志里取出 session", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loomy-ls-"));
    writeFileSync(path.join(dir, "000003.log"), log("session-a", "13800000000"));
    const value = _internal.readDesktopSessionFrom(dir);
    expect(value.session).toBe("session-a");
    expect(value.userid).toBe("261018152353105151");
    rmSync(dir, { recursive: true, force: true });
  });

  test("同一键多次写入时取最后一份", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loomy-ls-"));
    writeFileSync(
      path.join(dir, "000003.log"),
      Buffer.concat([log("old-session", "13800000000"), log("new-session", "13900000000")]),
    );
    expect(_internal.readDesktopSessionFrom(dir).session).toBe("new-session");
    rmSync(dir, { recursive: true, force: true });
  });

  test("多份 .log 文件时从编号最大的读起", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loomy-ls-"));
    writeFileSync(path.join(dir, "000003.log"), log("older", "13800000000"));
    writeFileSync(path.join(dir, "000004.log"), log("newer", "13900000000"));
    expect(_internal.readDesktopSessionFrom(dir).session).toBe("newer");
    rmSync(dir, { recursive: true, force: true });
  });

  test("JSON 内含花括号字符串时不误判配对", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loomy-ls-"));
    writeFileSync(path.join(dir, "000003.log"), log("s}es{sion", "13800000000"));
    expect(_internal.readDesktopSessionFrom(dir).session).toBe("s}es{sion");
    rmSync(dir, { recursive: true, force: true });
  });

  test("没有 session 键时返回 null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loomy-ls-"));
    writeFileSync(path.join(dir, "000003.log"), Buffer.from("_file://\x00\x01other-key\x01\x05value"));
    expect(_internal.readDesktopSessionFrom(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("目录不存在时返回 null", () => {
    expect(_internal.readDesktopSessionFrom("Z:\\does\\not\\exist")).toBeNull();
  });

  test("desktopStorageDirs 覆盖本平台", () => {
    const dirs = _internal.desktopStorageDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(dir.toLowerCase()).toContain("loomy");
      expect(dir.toLowerCase()).toContain("local storage");
    }
  });
});

describe("readDesktopSession (本机真实安装)", () => {
  test("本机装了 Loomy 且已登录时读得到", () => {
    const value = _internal.readDesktopSession();
    // 没装 / 没登录时返回 null, 装了返回带 session 的对象 —— 两种情况都算通过,
    // 这里只断言「不抛异常」与「形状正确」.
    if (value !== null) {
      expect(typeof value.session).toBe("string");
      expect(value.session.length).toBeGreaterThan(8);
    }
  });
});
