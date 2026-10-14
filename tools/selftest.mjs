/**
 * dsh-officeace 离线自检 —— 把每条路由、协议层、适配器逻辑过一遍，并交叉核对
 * 「浏览器半身调用的路径」与「宿主半身注册的路径」是否一一对应。
 *
 * 不需要 dsh、不需要真账号、**不联网**（协议层只做签名/解析的纯函数检查；
 * 需要出网的端点在这里用假服务器代替）。
 *
 * 跑法（内核 peer 依赖要从 profile 解析，所以必须在 profile 目录里跑）：
 *   cd %USERPROFILE%\.dsh\profiles\desktop
 *   node node_modules/dsh-officeace/tools/selftest.mjs
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 账号池落盘位置由 homedir() 决定 —— 先把它指到临时目录，别碰用户的真实账号池
const home = mkdtempSync(join(tmpdir(), 'oa-selftest-'))
process.env.USERPROFILE = home
process.env.HOME = home

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition === true) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `实际 ${a}${a === b ? '' : ` / 期望 ${b}`}`)
}

// ───────────────────────── 假 ctx / 假凭据服务 ─────────────────────────

const routes = {}
let injectCallback = null

function makeCtx(credentialMap) {
  return {
    inject: (deps, callback) => {
      injectCallback = callback
    },
    get: (name) => {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            return credentialMap.has(ref) ? { value: credentialMap.get(ref), source: 'test' } : undefined
          },
          async set(ref, value) {
            credentialMap.set(ref, value)
          },
          async unset(ref) {
            credentialMap.delete(ref)
          }
        }
      }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} }
  }
}

function scopedFor() {
  return {
    webServer: {
      register: (route) => {
        routes[route.path] = route.handler
      }
    },
    effect: (fn) => fn()
  }
}

// 驱动一次路由（把 (req,res) 换成 mock）
function drive(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = { method, url: path }
    const res = {
      statusCode: 0,
      writeHead(code) {
        this.statusCode = code
      },
      end(payload) {
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          reject(new Error(`响应不是 JSON：${String(payload).slice(0, 120)}`))
          return
        }
        resolve({ code: this.statusCode, body: parsed })
      }
    }
    req.on = body === undefined
      ? () => {}
      : (event, fn) => {
        if (event === 'data') fn(Buffer.from(JSON.stringify(body)))
        if (event === 'end') fn()
      }
    const handler = routes['/api/officeace']
    if (handler === undefined) {
      reject(new Error('路由未注册'))
      return
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

// ───────────────────────── 开跑 ─────────────────────────

console.log(`临时 HOME：${home}\n`)

const credentialMap = new Map()
const ctx = makeCtx(credentialMap)
const mod = await import(pathToFileURL(join(PKG, 'lib', 'index.js')).href)
const { AccountStore } = await import(pathToFileURL(join(PKG, 'lib', 'accounts.js')).href)
const proto = await import(pathToFileURL(join(PKG, 'lib', 'protocol.js')).href)

const accounts = new AccountStore(ctx, ctx.logger)

// 假的模型目录（真实实现要出网）
const adapter = {
  catalog: async () => [
    { id: 'glm-5.2', name: 'glm-5.2' },
    { id: 'glm-5.1', name: 'glm-5.1' },
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }
  ]
}

mod.registerRoutes(ctx, accounts, adapter, ctx.logger, fetch)
if (injectCallback === null) {
  console.log('  FAIL  路由注册：ctx.inject 未被调用')
  process.exitCode = 1
} else {
  injectCallback(scopedFor())
  check('路由已挂载到 /api/officeace', typeof routes['/api/officeace'] === 'function')
}

// ── A. 空账号池下的路由 ──
console.log('\n[A] 空账号池')
{
  const status = await drive('GET', '/api/officeace/status')
  check('GET /status 200', status.code === 200, `实际 ${status.code}`)
  eq('  · 空池 accounts', status.body.accounts, [])
  check('  · 空池 models 结构', Array.isArray(status.body.models?.items) && typeof status.body.models?.enabled === 'number')
  check('  · 带 login 字段', status.body.login === null || typeof status.body.login === 'object')

  const credits = await drive('GET', '/api/officeace/credits')
  check('GET /credits 200', credits.code === 200, `实际 ${credits.code}`)
  eq('  · 空池 total', credits.body.total, 0)

  const claim = await drive('POST', '/api/officeace/claim', {})
  check('POST /claim 200', claim.code === 200, `实际 ${claim.code}`)
  eq('  · 空池 claimed', claim.body.claimed, 0)

  for (const [method, path] of [
    ['GET', '/api/officeace/accounts/oa-9/test'],
    ['POST', '/api/officeace/accounts/oa-9/enable'],
    ['POST', '/api/officeace/accounts/oa-9/refresh'],
    ['POST', '/api/officeace/accounts/oa-9/remove']
  ]) {
    const r = await drive(method, path, method === 'POST' ? {} : undefined)
    check(`${method} ${path.replace('/api/officeace', '')} 未知账号→404`, r.code === 404, `实际 ${r.code}`)
  }

  const noModel = await drive('POST', '/api/officeace/models/disable', {})
  check('POST /models/disable 缺 model→400', noModel.code === 400, `实际 ${noModel.code}`)

  const unknown = await drive('GET', '/api/officeace/nope')
  check('GET /nope →404', unknown.code === 404, `实际 ${unknown.code}`)
}

// ── B. 有账号（含凭据）下的路由 ──
console.log('\n[B] 有账号 + 凭据')
accounts.add({ id: 'oa-1', ref: 'OFFICEACE_ACCOUNT_1' })
accounts.add({ id: 'oa-2', ref: 'OFFICEACE_ACCOUNT_2' })
accounts.setEnabled('oa-2', false)
credentialMap.set('OFFICEACE_ACCOUNT_1', JSON.stringify({ access_key_id: 'AK1', expires_at: new Date(Date.now() + 3600000).toISOString(), refresh_token: 'r', code_verifier: 'c', dpop_private_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }))
// oa-2 故意不给凭据

{
  const status = await drive('GET', '/api/officeace/status')
  eq('GET /status 账号数', status.body.accounts.length, 2)
  const first = status.body.accounts[0]
  check('  · 账号行带 accessKey', first.accessKey === 'AK1', `实际 ${first.accessKey}`)
  check('  · 账号行带 expiresAt', typeof first.expiresAt === 'number')
  check('  · 账号行带 refreshable', first.refreshable === true)
  check('  · 账号行带 limitedUntil', first.limitedUntil === 0)
  check('  · 账号行带 modelInfoError 字段', 'modelInfoError' in first)
  check('  · 停用状态被带出', status.body.accounts[1].enabled === false)

  const credits = await drive('GET', '/api/officeace/credits')
  check('GET /credits 有账号时 200', credits.code === 200, `实际 ${credits.code}`)
  check('  · 缺网关地址时给出明确原因', String(credits.body.accounts[0].error ?? '').includes('网关地址'), `实际 ${credits.body.accounts[0].error}`)
  check('  · 无凭据的账号标为凭据缺失', String(credits.body.accounts[1].error ?? '').includes('凭据缺失'), `实际 ${credits.body.accounts[1].error}`)

  // 模型开关必须返回**完整**状态（曾经只回模型那段，客户端一覆盖就把 accounts 抹掉）
  const disabled = await drive('POST', '/api/officeace/models/disable', { model: 'glm-5.2', disabled: true })
  eq('POST /models/disable 后 accounts 仍在', disabled.body.accounts?.length, 2)
  eq('  · glm-5.2 已关', disabled.body.models.items.find((m) => m.id === 'glm-5.2').disabled, true)
  const allOff = await drive('POST', '/api/officeace/models/disableAll', { disabled: true })
  eq('POST /models/disableAll 后 accounts 仍在', allOff.body.accounts?.length, 2)
  eq('  · 全部已关', allOff.body.models.enabled, 0)
  const allOn = await drive('POST', '/api/officeace/models/disableAll', { disabled: false })
  eq('  · 全部开启后 enabled', allOn.body.models.enabled, 3)

  // 停用 / 启用
  const off = await drive('POST', '/api/officeace/accounts/oa-1/enable', { enabled: false })
  eq('POST /accounts/oa-1/enable {false}', off.body.account.enabled, false)
  await drive('POST', '/api/officeace/accounts/oa-1/enable', { enabled: true })

  // 移除（连凭据一起清）
  const removed = await drive('POST', '/api/officeace/accounts/oa-2/remove')
  check('POST /accounts/oa-2/remove 200', removed.code === 200)
  eq('  · 移除后账号数', accounts.list().length, 1)

  // 测试按钮：缺网关地址时必须说清（不能报「连接正常 0 个模型」）
  const test = await drive('GET', '/api/officeace/accounts/oa-1/test')
  check('GET /accounts/oa-1/test 200', test.code === 200, `实际 ${test.code}`)
  check('  · 缺网关地址时 ok=false 且给出原因', test.body.ok === false && String(test.body.error).includes('网关地址'), `实际 ${JSON.stringify(test.body)}`)
}

// ── C. 账号池：限流记账 / 登录状态 / id 唯一 ──
console.log('\n[C] 账号池')
{
  const resetAt = Date.now() + 3600000
  accounts.recordRateLimit('oa-1', 'glm-5.2', resetAt)
  check('限流记账：该模型受限', accounts.isLimited('oa-1', 'glm-5.2') === true)
  check('限流记账：按模型粒度（别的模型不受限）', accounts.isLimited('oa-1', 'glm-5.1') === false)
  check('限流记账：limitedUntil 精确', accounts.limitedUntil('oa-1') === resetAt)
  accounts.recordRateLimit('oa-1', 'glm-5.2', resetAt - 60000)
  check('限流记账：不接受更早的时刻', accounts.limitedUntil('oa-1') === resetAt)

  accounts.setLogin({ status: 'failed', error: '测试用失败' })
  eq('登录状态落盘可读', accounts.login().error, '测试用失败')
  const status = await drive('GET', '/api/officeace/status')
  eq('  · /status 带出 login', status.body.login.status, 'failed')

  const slot = accounts.nextRef()
  check('nextRef 不与既有 id/ref 撞车', slot.id !== 'oa-1' && slot.ref !== 'OFFICEACE_ACCOUNT_1', JSON.stringify(slot))
}

// ── D. 协议层（纯函数） ──
console.log('\n[D] 协议层')
{
  const { verifier, challenge } = proto.pkcePair()
  check('PKCE：verifier/challenge 非空且不同', verifier.length > 20 && challenge.length > 20 && verifier !== challenge)
  const kp = proto.dpopKeyPair()
  const jws = proto.dpopJws(kp.privateKey, kp.publicJwk, 'POST', 'https://sts.example.com/t')
  const parts = jws.split('.')
  check('DPoP：JWS 三段', parts.length === 3)
  check('DPoP：签名为 64 字节 raw R‖S', Buffer.from(parts[2], 'base64url').length === 64, String(Buffer.from(parts[2], 'base64url').length))
  check('DPoP：私钥可从 JWK 还原', typeof proto.privateKeyFromJwk(kp.privateKey.export({ format: 'jwk' })) === 'object')

  const sdk = proto.sdkHmacHeaders('AK', 'SK', 'ST', 'POST', 'https://x.example.com/a/b', Buffer.from('{}'), {})
  check('SDK-HMAC：Authorization 形状', String(sdk.Authorization).startsWith('SDK-HMAC-SHA256 Access=AK,SignedHeaders='), String(sdk.Authorization).slice(0, 60))
  const v11 = proto.v11Headers({ access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST' }, 'GET', 'https://x.example.com/v1/subscription', { 'x-subscription-type': 'v2' }, '')
  check('V11：Authorization 形状', /^V11-HMAC-SHA256 Credential=AK\/\d{8}\/cn-southwest-2\/apic, SignedHeaders=/.test(String(v11.Authorization)), String(v11.Authorization).slice(0, 70))
  eq('apiOrigin：去掉尾部 /v2', proto.apiOrigin({ model_api_url_base: 'https://g.example.com/v2' }), 'https://g.example.com')
  eq('normalizeBase：补 /v2', proto.normalizeBase('g.example.com'), 'https://g.example.com/v2')
  eq('basicAuth', proto.basicAuth('a', 'b'), `Basic ${Buffer.from('a:b').toString('base64')}`)

  const balance = proto.mapBalance({ skus: [{ sku_name: '个人体验版', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 500, current_value: 120 }] }], bonus_skus: [{ activity_name: '新用户', points: 4000, current_value: 1000, status: 'SUBSCRIBED' }] })
  eq('mapBalance：合计（380 + 3000）', balance.total, 3380)
  eq('mapBalance：分项数', balance.packages.length, 2)
  eq('claimedPoints：空数组→null', proto.claimedPoints([]), null)
  eq('claimedPoints：求和', proto.claimedPoints([{ points: 100 }, { points: 20 }]), 120)
}

// ── E. 适配器：模型过滤 / 目录回落 / 换号 / 限流跳过 ──
console.log('\n[E] 适配器')
{
  const { OfficeAceAdapter } = mod

  // 用假 fetch 造一个网关
  let lastAuth = ''
  let mode = 'ok'
  const fakeFetch = async (url, options) => {
    lastAuth = String(options?.headers?.Authorization ?? '')
    const body = String(url).includes('/models')
      ? JSON.stringify({ data: [{ id: 'glm-5.2' }, { id: 'glm-5.1' }, { id: 'deepseek-v4.1-flash' }] })
      : ''
    if (mode === 'hit') {
      return { ok: true, status: 200, body: null, async text() { return body }, async json() { return JSON.parse(body) } }
    }
    if (mode === '429') {
      return { ok: false, status: 429, body: null, async text() { return '{"error":"rate limit"}' }, async json() { return {} } }
    }
    return { ok: false, status: 500, body: null, async text() { return 'boom' }, async json() { return {} } }
  }

  // ⚠️ 用**同一个** store + **同一个**凭据 map（适配器从 store 读凭据，
  // 早先把凭据写进另一个假服务里，结果适配器读不到 → 误判成"没有可用账号"）
  const list = new AccountStore(ctx, ctx.logger)
  const credentials = ctx.get('credentials')
  // 清掉上一组留下的账号，别让它污染本组的"无账号"断言
  for (const leftover of list.list()) await list.remove(leftover.id)
  const adapter2 = new OfficeAceAdapter({ accounts: list, fetchImpl: fakeFetch, logger: ctx.logger, config: { maxTokens: 1024 } })

  // 没有账号 → 目录为空，模型清单为空
  eq('无账号时 catalog 为空', await adapter2.catalog(), [])
  eq('无账号时 listModels 为空', await adapter2.listModels(), [])

  list.add({ id: 'oa-1', ref: 'OFFICEACE_ACCOUNT_1' })
  await credentials.set('OFFICEACE_ACCOUNT_1', JSON.stringify({ access_key_id: 'AK1', model_app_key: 'K1', model_app_secret: 'S1', model_api_url_base: 'https://gw.example.com/v2' }))

  mode = 'hit'
  const catalog = await adapter2.catalog()
  eq('有账号时 catalog 来自远端', catalog.map((m) => m.id), ['glm-5.2', 'glm-5.1', 'deepseek-v4.1-flash'])

  list.setModelDisabled('glm-5.2', true)
  const visible = await adapter2.listModels()
  eq('模型开关：关掉的模型从清单里消失', visible.map((m) => m.id), ['glm-5.1', 'deepseek-v4.1-flash'])
  list.setModelDisabled('glm-5.2', false)

  // 远端失败 → 回落静态集
  const oldFetch = adapter2.fetchImpl
  adapter2.fetchImpl = async () => ({ ok: false, status: 503, async text() { return 'x' }, async json() { return {} } })
  const fallback = await adapter2.catalog()
  check('远端失败时回落静态集', fallback.length === proto.DEFAULT_MODELS.length, `实际 ${fallback.length}`)
  adapter2.fetchImpl = oldFetch

  // 换号：第一个账号 500（还没吐内容）→ 应该换第二个账号
  list.add({ id: 'oa-2', ref: 'OFFICEACE_ACCOUNT_2' })
  await credentials.set('OFFICEACE_ACCOUNT_2', JSON.stringify({ access_key_id: 'AK2', model_app_key: 'K2', model_app_secret: 'S2', model_api_url_base: 'https://gw.example.com/v2' }))
  const seen = []
  adapter2.fetchImpl = async (url, options) => {
    const auth = String(options?.headers?.Authorization ?? '')
    seen.push(auth)
    if (auth.includes(Buffer.from('K1:S1').toString('base64'))) {
      return { ok: false, status: 500, async text() { return 'boom' }, async json() { return {} } }
    }
    // 第二个账号：吐一个正常 SSE 流
    const payloads = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const p of payloads) yield Buffer.from(p)
      })()
    }
  }

  const chunks = []
  try {
    for await (const chunk of adapter2.stream({ model: 'glm-5.1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
  } catch (error) {
    check('换号后应成功', false, String(error?.message ?? error))
  }
  check('换号：第一个账号失败后用了第二个', seen.length === 2, `实际尝试 ${seen.length} 次`)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  eq('换号后正文正确', text, 'hi')
  check('流以 finish 收尾', chunks[chunks.length - 1]?.type === 'finish', String(chunks[chunks.length - 1]?.type))

  // 限流：429 → 记账 → 下次直接跳过该账号
  adapter2.fetchImpl = async () => ({ ok: false, status: 429, async text() { return '{"error":"rate limit"}' }, async json() { return {} } })
  let firstError
  try {
    for await (const _chunk of adapter2.stream({ model: 'glm-5.1', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) { /* drain */ }
  } catch (error) {
    firstError = error
  }
  check('429：两个账号都限流后报错', firstError !== undefined, String(firstError?.message ?? ''))
  check('429：已记账（该模型对 oa-1 限流）', list.isLimited('oa-1', 'glm-5.1') === true)
  const skipped = []
  adapter2.fetchImpl = async (url, options) => {
    skipped.push(String(options?.headers?.Authorization ?? ''))
    return { ok: false, status: 500, async text() { return 'boom' }, async json() { return {} } }
  }
  try {
    for await (const _chunk of adapter2.stream({ model: 'glm-5.1', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) { /* drain */ }
  } catch {
    /* 预期失败 */
  }
  check('429 后：该模型不再挑受限账号', skipped.every((a) => !a.includes(Buffer.from('K1:S1').toString('base64'))), `实际发起 ${skipped.length} 次`)
}

// ── F. 客户端 ↔ 宿主 路径交叉核对 ──
console.log('\n[F] 客户端调用的路径 vs 宿主注册的路由')
{
  const clientSource = readFileSync(join(PKG, 'client.js'), 'utf8')
  const serverSource = readFileSync(join(PKG, 'lib', 'index.js'), 'utf8')

  // ⚠️ 正则要认全 `get(`/`post(` 两种调用（早先只认 get/set，漏掉了 post）
  const clientPaths = new Set()
  for (const m of clientSource.matchAll(/(?:get|post)\((['"`])([^'"`]+)\1/g)) clientPaths.add(m[2])

  const serverPaths = new Set()
  for (const m of serverSource.matchAll(/route === '([^']+)'/g)) serverPaths.add(m[1])
  // 账号级动作：`action === '<动词>'`（变量名不是 accountMatch[2]）
  for (const m of serverSource.matchAll(/action === '([a-z]+)'/g)) serverPaths.add(`/accounts/<id>/${m[1]}`)

  const normalize = (p) => p.replace(/\$\{[^}]*\}/g, '<id>').replace(/\/+$/, '') || '/'
  const known = new Set([...serverPaths].map(normalize))
  known.add('/accounts/<id>/test')

  const unknown = []
  for (const raw of clientPaths) {
    const p = normalize(raw)
    // 客户端里有 '/accounts/…' 这种带 encodeURIComponent 的，归一化后比对
    if (!known.has(p) && !known.has(p.replace(/\/accounts\/[^/]+/, '/accounts/<id>'))) unknown.push(raw)
  }
  check('客户端调用的路径都能在宿主找到', unknown.length === 0, unknown.join(', '))

  // 反向：宿主注册了但客户端没用的（提示用，不算失败）
  const unused = [...serverPaths].filter((p) => ![...clientPaths].some((c) => normalize(c) === p))
  if (unused.length > 0) console.log(`  提示  宿主有而客户端未直接调用：${unused.join(', ')}`)
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'='.repeat(60)}`)
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
}
