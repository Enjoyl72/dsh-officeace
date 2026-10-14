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
| **界面卡片** | dsh 的**设置**里有一页「果办OfficeAce」：账号列表（启用/到期 + **↑↓调序/测试/续期/停用/改名/移除**）、**模型开关区**（已开启 x/y + 全部开启/关闭 + 逐模型开关）、卡头总积分与每账号积分（点账号名或积分展开组成明细）、每日领取 |
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
| `POST /accounts/<id>/nickname` | 改账号显示名（`{nickname}`，留空＝回到用 Access Key 显示） |
| `POST /accounts/reorder` | 重排账号顺序（`{ids:[…]}`，必须是现有账号的完整排列）——**数组顺序 = 候选优先级** |
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

dsh 的插件要装**两步** —— 只做第一步的话包是装上了，但**不会被加载**，而且不留任何提示：

```bash
# 第一步：把包加进 profile 的依赖
dsh plugin --profile desktop add github:Enjoyl72/dsh-officeace
# 本地开发/自用则用：dsh plugin --profile desktop add file:C:\path\to\dsh-officeace
```

第二步：**手工**把包名写进 profile 的加载清单，也就是 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …原有的那几项…
        "dsh-officeace"
      ]
    }
  }
}
```

> **为什么必须两步**：`dsh plugin add` 只往 `dependencies` 里加了一条依赖，而
> **哪些包会被加载**是由 `dsh.profile.bundles` 决定的。两处都做了才生效。

然后**重启 dsh** —— 插件是启动时加载的，改动不会热更新。想确认装载成功，
看进程日志里有没有这一行：

```
officeace: 渠道已注册（provider "officeace"）
```

日志不好找也无所谓：**设置 → 果办OfficeAce** 卡片在，就是装上了。

> ⚠️ **同一台机器上只能有一个来源注册 `officeace`**。若你另外还把这条渠道打在上游
> `dsh-our-free-model` 里（另一仓的 `apply-officeace.py`），请**先撤掉那份补丁**
> （从 `*.officeace-bak-*` 备份恢复），否则两个插件抢同一个 provider 路由会报重复注册。

## 使用

**没有需要敲的命令，全在界面上** —— 入口是 **设置 → 果办OfficeAce**。

### 1. 登录（只需一次）

点卡片上的 **「＋ 添加账号」** → dsh 打开浏览器跳到华为云授权页 → 用你自己的华为云账号
登录并同意授权 → 页面显示「登录成功，可关闭此页」，卡片上的账号列表就多出一个账号。

- **浏览器没弹出来**：卡片下方会显示一条同款链接，手工打开即可。
- **不需要装 OfficeAce 客户端，也不需要 API Key。**
- 中途失败（比如超时）：卡片下方会写出原因，重新点一次即可。

### 2. 开始对话

在**模型选择器里选 `officeace/<模型 id>`**，例如 `officeace/deepseek-v4.1-flash`。
模型清单是登录后从网关**实拉**的（当前约 21 个），不是写死的。

**工具调用可用**（读写文件、执行命令等），所以直接派具体活儿就行 —— 比如
「写个九九乘法表网页」。

### 3. 日常会用到的东西

| 想做什么 | 在哪点 |
|---|---|
| 看还剩多少积分 | 卡头右侧的**总积分**。点**账号名**或它后面的**积分数**，就地展开该账号的积分组成（各包还剩多少、何时到期） |
| 领今天的活动奖励 | **「🎁 领取」** —— 逐个账号领一遍并汇总结果 |
| 手工重查积分 | **「⟳ 积分」** |
| 凭据要过期了 | 不用管：每 30 分钟自动续期（距过期不足 1 小时才续）。也可点账号上的「续期」立刻续 |
| 某个账号不对劲 | 点该账号的**「测试」** —— 实拉一次模型清单，成功会显示「连接正常（21 个模型 · 262ms）」 |
| 某个账号最近取密钥失败过 | 账号行下方会写**失败原因**（不是只进日志），点「续期」重试 |

### 4. 多个账号

一条渠道可以挂任意多个华为云账号，**请求失败会自动换下一个**（规则见下面的「账号池规则」）。

- **「＋ 添加账号」**：再登一个号
- **`↑` `↓`**：调顺序 —— **数组顺序就是候选优先级**，越靠前越先用
- **「改名」**：起个好记的名字（留空＝恢复显示 Access Key）
- **「停用」**：只是「别拿它跑对话」；**续期和每日领取照旧**，不会被落下
- **「移除」**：连凭据一起清掉

### 5. 模型开关

在「▸ 模型 (21/21)」里展开，可逐个模型**开/关**，或**全部开启/全部关闭**。
关掉的模型会**从 dsh 的模型选择器里消失**（不是灰掉，是不出现）。

## 出问题时

| 现象 | 多半是什么 | 怎么办 |
|---|---|---|
| 卡片不出现，或模型选择器里没有 `officeace/...` | 插件没被加载 | 检查 `dsh.profile.bundles` 里有没有 `dsh-officeace`，再重启 dsh |
| 账号行显示「**上次取网关密钥失败：…**」 | 凭据没换到网关地址 | 点该账号「续期」重试；连续失败就重新登录该账号 |
| 账号行出现红色「**限流至 …**」 | 这个账号对**这个模型**触发了限流/额度不足 | 等它自己解禁，或换别的模型，或多加几个账号 |
| 对话报「**没有可用账号**」 | 账号全被停用，或都没登录 | 到卡片上启用 / 添加账号 |
| 报「**provider 重复注册**」 | 同时装了两份来源（本插件 + 上游补丁） | 撤掉上游那份补丁 |

## 账号池规则（多账号时按这个来）

**候选顺序** = 账号列表的**数组顺序**（= 添加顺序，卡片上的 `↑`/`↓` 可调）。是固定顺序，**不是轮询**。

一次请求的挑号流程：

1. 逐个过滤：停用的、**对该模型**还在限流冷却里的、读不到凭据的 → 跳过
2. 剩下的里，**手里压着快过期积分**的账号排前面先用掉（依据最近一次「⟳ 积分」留下的快照；
   没点过就把数据当未知，退回数组顺序）—— 同档保持数组顺序
3. 依次试，**最多 3 个**（`MAX_ROTATE`）
4. ⚠️ **只在还没吐出任何内容时才能换号** —— 模型一旦开口，再出错就直接抛，不换

**限流记账粒度是「账号 × 模型」**：某账号对某模型失败后进冷却，**换别的模型它照样能用**。

解禁时刻的来源，从准到粗三级：

| 情况 | 冷却到 |
|---|---|
| 华为返回的文本里有 `将在 … UTC+8` | 就用那个时刻 |
| 解析不出，且是**额度耗尽**类（配额/积分不足/quota…） | UTC+8 **次日零点** |
| 解析不出，且只是**频率类** 429 | **1 小时**后 |

（曾经一律兜到次日零点 —— 一个几秒就恢复的 429 会把账号废掉一整天，已修。）

**续期**：每 30 分钟扫一遍，距过期不足 1 小时才续；`refresh_token` 一次性，所以续期走全局串行链，
对话路径只在 401/403 时补续一次。**续期不看启停**（停用只是"别拿它跑对话"）。

**积分与领取**：`/credits` 查**所有**账号（含停用），`/claim` 也领**所有**账号（含停用）——
停用不代表该账号的每日奖励就作废。两者都串行执行，避免风控；单账号失败不影响其它。

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

- **工具历史按原生结构发**（assistant 带 `tool_calls` + 紧跟 `role:'tool'`），与其他渠道一致。
  ⚠️ 有一条硬约束：`role:'tool'` 必须紧跟在**声明了该 `tool_call_id`** 的 assistant 之后，
  否则网关整轮 400（`ModelArts.81001`）。所以历史对不上时（被裁剪、id 缺失、跨会话拼接）
  会自动**降级成文本**发出去 —— 宁可少点结构，也不让整轮挂掉。
- **不发 `temperature`**：请求体照抄实测可用的形状。
- **不解析 DSML**：华为这边 DeepSeek 系模型有个"文本化工具调用"的方言（`<｜DSML｜call>`），
  上游的 codearts 渠道专门为它做了 prompt + 解析器。本渠道**不声明 `tools` 时**也可能撞上它，
  但实际使用中 `tools` 总是声明着的（实测此时模型一律走原生 `tool_calls`），故暂不处理。
- **纯逆向**：OfficeAce 客户端 / 华为云 MaaS 一改就可能失效，届时按上面的端点表重新核对。

## 许可

MIT（见 `LICENSE`）。协议细节来自对 OfficeAce 客户端与华为云接口的逆向；本渠道仅供**用户对
自己账号**的额度接入使用，上游条款与可用性可能随时变化。
