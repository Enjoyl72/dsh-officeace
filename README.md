# dsh-officeace

给 **dsh（DeepSeek Harness）** 用的**果办OfficeAce**（华为云 AgentArts）渠道 —— **只含这一条渠道**。

> **为什么单独做一个包**：此前这条渠道是"打在上游插件 `dsh-our-free-model` 里的补丁"，
> 插件每次**自更新**都会覆盖 `pack.js`/`client.js` 把渠道抹掉；且上游换构建后补丁锚点会全部失效。
> 本包只依赖 dsh 的内核契约（`ctx.llm` / `ctx.credentials` / `ctx.commands`），
> **不依赖任何上游插件**，因此与上游更新完全解耦。

---

## 能力

| 能力 | 说明 |
|---|---|
| **界面卡片** | dsh 的**设置**里有一页「果办OfficeAce」：账号列表（启用/到期 + **测试/续期/停用/移除**）、**模型开关区**（已开启 x/y + 全部开启/关闭 + 逐模型开关）、**积分明细**、每日领取 |
| 对话 | 注册 provider `officeace`，模型出现在 dsh 的模型选择器里，直接选即可 |
| **多账号** | 一条渠道可挂多个账号（各自一份凭据），**请求失败按顺序换号**（只在还没吐出内容时换；上限 3 个） |
| 登录 | 点「＋ 添加账号」→ **浏览器完成华为云授权**（宿主打开浏览器，客户端留链接兜底）；无需 OfficeAce 客户端、无需 API Key |
| 模型清单 | 先试远端 `GET <网关>/v1/models`，失败回落静态集；**被关掉的模型从 dsh 的模型选择器里消失** |
| 续期 | 凭据是 ~2 小时的 STS 临时凭据：每 30 分钟自动续期一次（`refresh_token` 一次性，故只在这一个入口续），401 时再补一次 |

**没有命令**：登录/看数据全在卡片上，不需要在输入栏敲东西。

界面的数据走本插件自己的**同源路由** `/api/officeace/*`（宿主半身用
`server.register({kind:'prefix', path})` 挂上）：

| 路由 | 作用 |
|---|---|
| `GET /status` | 账号列表（id/昵称/启用/accessKey/到期/可续期）+ 模型清单（含每项 `disabled`） |
| `POST /login` | 起 OAuth，返回 `loginUrl` 与新账号 id（宿主打开浏览器，客户端轮询等回调完成） |
| `GET /credits` | 逐账号积分（`{accounts:[{id,ok,total,packages,error}], total}`） |
| `POST /claim` | 逐账号领取每日奖励并汇总 |
| `POST /accounts/<id>/enable` | 启用/停用该账号 |
| `POST /accounts/<id>/refresh` | 续期该账号并回写 |
| `POST /accounts/<id>/remove` | 移除该账号（连凭据一起清） |
| `GET /accounts/<id>/test` | 用该账号实拉一次模型清单（连通性 + 耗时） |
| `POST /models/disable` | `{model, disabled}` 单个模型开关 |
| `POST /models/disableAll` | `{disabled}` 全部开关 |

**落盘位置**：账号池与模型黑名单在 `~/.dsh/officeace/state.json`；凭据本体在 dsh 的凭据服务里，
每个账号一份（ref `OFFICEACE_ACCOUNT_1/2/…`）。早先单账号版本用的 `OFFICEACE_ACCESS_KEY_ID`
会在首次加载时被**自动收编为 1 号账号**，不必重新登录。

浏览器半身是**手写的 ModuleLoader bundle**（`client.js`，**无构建步骤**，除 shell 已提供的
`react` 外无依赖），配色一律取主题变量 `--dsw-alias-*`，因此深/浅色切换都能跟。

## 安装

```bash
# 本地目录（开发/自用）
dsh plugin --profile desktop add file:C:\Users\86195\dsh-officeace

# 或不发布 npm，直接从 GitHub 装
dsh plugin --profile desktop add github:Enjoyl72/dsh-officeace
```

装完**重启 dsh**。日志里应出现：

```
officeace: 渠道已注册（provider "officeace"，凭据引用 OFFICEACE_ACCESS_KEY_ID）
```

> ⚠️ **同一台机器上只能有一个来源注册 `officeace`**。若你还把本渠道打在上游
> `dsh-our-free-model` 里（见另一仓的 `apply-officeace.py`），请**先撤掉那份补丁**
> （从 `*.officeace-bak-*` 备份恢复），否则两个插件抢同一个 provider 路由会报重复注册。

## 使用

在 dsh 里输入（命令面板 / 斜杠命令）：

```
/officeace login     打开浏览器完成华为云授权（也回一个链接兜底）
/officeace status    登录态、凭据到期时间、可用模型数
/officeace models    列出本渠道的模型 id
/officeace credits   积分明细（主积分 + 各活动池）
/officeace claim     领取每日奖励
/officeace logout    清除本机凭据
```

登录成功后，在模型选择器里选 `officeace/<model>` 即可对话。

## 协议（都是逆向来的，改动前先核对）

```
1) state      POST https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/state
2) 授权       GET  https://auth.huaweicloud.com/authui/v1/oauth2/authorize
                  ?client_id=pdp5_for_agentarts & code_challenge=… & state=… & scope=openid
                  & redirect_uri=http://127.0.0.1:<port>/oauth/callback & response_type=code
                  （外层再套 authui/login.html?service=…）
3) 换 token   POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens   （与 CodeArts 同一个端点）
                  DPoP: <ES256 JWS>  + 表单（client_id/code/code_verifier/grant_type[/refresh_token]）
              → credentials.{access_key_id, secret_access_key, security_token, expiration} + refresh_token
4) 取网关密钥 POST https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-subscription
                  SDK-HMAC-SHA256 签名，头 x-subscription-type: v2
              → model_info.model_auth_info.{model_app_key, model_app_secret} + model_info.model_api_url_base
5) 对话       POST <model_api_url_base>/chat/completions        Authorization: Basic base64(appKey:appSecret)
6) 额度       GET  <origin>/v1/subscription                     V11-HMAC-SHA256 签名，头 x-subscription-type: v2
   领取       POST <origin>/v1/subscription/bonus/claim         必须 Content-Type: application/json + body {}
```

`origin` = `model_api_url_base` 去掉尾部 `/v2`。V11 的要点：`scope = <yyyymmdd>/cn-southwest-2/apic`，
`derived = HMAC(HMAC(ak,sk), scope‖0x01)[0:32]`，`signature = HMAC(**hex(derived)**, stringToSign)`
（key 是 derived 的**十六进制串**，不是原始字节）。

更完整的逆向记录、以及"打在上游插件里"的那套补丁，见另一仓库
`Enjoyl72/-OfficeAce-_to_dsh-our-free-model`。

## 已知局限

- **单账号**：只保存一份凭据（引用 `OFFICEACE_ACCESS_KEY_ID`）。多账号未做。
- **工具历史折成文本**：历史里的 `tool-call`/`tool-result` 转成文本行（兼容面最广），
  当前请求的 `tools` 仍按原生声明——这样模型能正常调用工具。
- **不发 `temperature`**：请求体照抄实测可用的形状。
- **纯逆向**：OfficeAce 客户端 / 华为云 MaaS 一改就可能失效，届时按上面的端点表重新核对。

## 自检（离线，不需要 dsh / 真账号 / 联网）

```bash
# 内核 peer 依赖要从 profile 解析，所以必须在 profile 目录里跑
cd %USERPROFILE%\.dsh\profiles\desktop
node node_modules/dsh-officeace/tools/selftest.mjs
```

覆盖 67 项：**每条路由**（含未知账号/缺参数/未知路径的边界）、**账号池**（限流记账按模型粒度、
登录状态落盘、`nextRef` 不撞 id）、**协议层**（PKCE / DPoP 64 字节签名 / SDK-HMAC 与 V11 的
Authorization 形状 / 余额汇总）、**适配器**（模型开关过滤、远端失败回落静态集、失败换号、
429 记账后跳过该账号），以及**「浏览器半身调用的路径」与「宿主注册的路径」的交叉核对**
（客户端调了宿主没注册的路径 → 运行时就是 404，这类最容易漏）。

自检**覆盖不到**的（只能真机看）：真实网关的请求/响应、华为云授权流程、界面渲染。

## 许可

MIT（见 `LICENSE`）。协议细节来自对 OfficeAce 客户端与华为云接口的逆向；本渠道仅供**用户对
自己账号**的额度接入使用，上游条款与可用性可能随时变化。
