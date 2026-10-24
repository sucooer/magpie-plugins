# magpie-plugin-loomy

[magpie](https://usemagpie.ai) / OpenCode 供应商插件：**Loomy（讯飞）**。

本插件把 Loomy（讯飞星火推出的编程套餐）接入 magpie，agent 可以用
`loomy/<模型>` 访问它的模型，和其他供应商一样（多账号、故障切换、用量）。

| 平面 | 地址 | 说明 |
| --- | --- | --- |
| 账号 CAccount | `https://account.xfinfr.com` | HMAC-SHA1 签名头（客户端内置 AccessKey 对），手机号短信验证码登录 |
| 集成网关 | `https://loomyad.xunfei.cn` | 积分、签到；鉴权双头 `token` + `Authorization: Bearer` |
| 模型网关 | `{集成网关}/api/v1` | OpenAI 兼容：`GET /models`、`POST /chat/completions` |

## 登录方式

1. **Loomy 桌面端登录态**：自动读取本机 Loomy 客户端已登录的账号，无需短信。
1. **手机号 + 短信验证码**：输入手机号后自动发码，再输入 6 位验证码即可。
   session 有效期 **14 天**，上游没有续期接口，过期后需重新登录。
2. **粘贴 session**：在 Loomy 客户端登录后，从抓包或客户端存储中取出
   session（同时是模型网关的 token）粘贴进来；插件会调 `/api/v1/models`
   校验有效性。

### 桌面端登录态从哪来

Loomy 是 Electron 应用，登录态以**明文 JSON** 存在 Chromium Local Storage
（leveldb）的 `loomy-auth-session` 键里：

```text
Windows  %APPDATA%\Loomy\Local Storage\leveldb\*.log
macOS    ~/Library/Application Support/Loomy/Local Storage/leveldb/*.log
Linux    ~/.config/Loomy/Local Storage/leveldb/*.log
```

```json
{"phone":"…","maskedPhone":"198****3408","session":"…","userid":"…","loggedInAt":"…"}
```

无加密、无 DPAPI（客户端 `Local State` 里那把 `os_crypt` 密钥用于 Cookie，
不覆盖 Local Storage）。插件从编号最大的 `.log` 往前读，取同一键最后一次
写入的值。导入后会调一次 `/api/v1/models` 校验，失效时提示去客户端重新登录。

登录信息保存在 magpie 的 `plugin-auth.json`（权限 600），与 OpenCode 的
`auth.json` 格式相同。

## 模型与能力

- 模型目录来自 `GET https://loomyad.xunfei.cn/api/v1/models`（OpenAI 形态），
  能力位（思考 / 工具 / 图片 / 视频）读上游 `capabilities`；积分倍率从展示名
  尾部 `(x3.0)` 括号中拆出。
- **deepseek 系模型的图片适配**：`deepseek-v4-flash-0731` 等只认
  `<image_base64>` 标记，标准 `image_url` 会被上游当截断文本读；插件在转发前
  自动改写（GLM 等模型保持 `image_url`，宁可不转不能转错）。

## 用量与签到

- 余额来自 `GET /api/v2/points/records` 的摘要字段（Loomy 没有独立余额接口）：
  `balance`（永久积分）+ `dailyBalance`（每日赠送积分）。
- 签到 = `POST /api/v1/points/first-login`（每日首次调用把赠送积分刷回），
  按天幂等。

## 环境变量（可选覆盖）

| 变量 | 默认 |
| --- | --- |
| `LOOMY_XFYUN_BASE_URL` | `https://account.xfinfr.com` |
| `LOOMY_POINTS_BASE_URL` | `https://loomyad.xunfei.cn` |
| `LOOMY_XFYUN_ACCESS_KEY_ID` | 客户端内置值 |
| `LOOMY_XFYUN_ACCESS_KEY_SECRET` | 客户端内置值 |
| `LOOMY_XFYUN_APP_ID` | `GM3LOOMY` |

## 安装

magpie 支持从 npm 包名、GitHub 仓库、本机文件夹三种来源安装，任选其一。

```bash
# npm 包
magpie plugin add magpie-plugin-loomy

## 测试

```bash
bun test        # 单元测试（纯函数，不打上游）
```

在沙箱里验证（不影响日常使用的 magpie）：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add "$PWD"        # 在 packages/loomy 目录下执行，装的是当前开发中的版本
m plugin login loomy
m provider test loomy
m quota
```

## 免责

本项目仅用于个人学习与研究，与科大讯飞及 Loomy 无任何关联，未获得其授权、
认可或赞助。HMAC-SHA1 签名使用的 AccessKey 对随官方客户端安装包分发，
属于客户端指纹复刻，不是用户账号凭证。
