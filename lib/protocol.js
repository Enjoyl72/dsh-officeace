/**
 * 果办OfficeAce（华为云 AgentArts）协议层 —— 纯 Node 内置模块，无第三方依赖。
 *
 * 只做四件事：
 *   1. 登录：取 state → PKCE + DPoP → 本机回调收 code → STS 换临时凭据；
 *   2. 网关密钥：`client-subscription`（SDK-HMAC-SHA256）拿 model_app_key/secret + 网关基址；
 *   3. 对话所需：Basic 头 + 远端模型目录 `GET <base>/models`；
 *   4. 额度：`/v1/subscription` 与 `/v1/subscription/bonus/claim`（V11-HMAC-SHA256 签名）。
 *
 * 这些端点与签名参数来自对 OfficeAce 客户端（v1.3.4）+ 华为云 MaaS 的逆向，细节见仓库 README。
 * ⚠️ 纯逆向：上游一改就可能失效。
 *
 * @module dsh-officeace/protocol
 */

import { createServer } from 'node:http'
import { createSign, createHmac, createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto'

/** OAuth 客户端 id（OfficeAce 客户端用的那个） */
export const OFFICEACE_CLIENT_ID = 'pdp5_for_agentarts'
/** 华为云统一认证基址 */
const AUTH_BASE = 'https://auth.huaweicloud.com'
/** AgentArts / claw 基址（取 state、取网关密钥都在这） */
const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
/** STS 换 token 端点（与 CodeArts 同一个） */
const STS_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
/** MaaS 订阅接口所在区域（V11 scope 用） */
const REGION = 'cn-southwest-2'
/** 回调路径 */
const REDIRECT_PATH = '/oauth/callback'
/** 登录等待上限（ms） */
const OAUTH_TTL_MS = 10 * 60 * 1000
/** 远端模型目录拉取上限（ms） */
const PROBE_TIMEOUT_MS = 20000

/** 静态回落模型集（远端目录拉不到时用；这几个已在实测里确认可用） */
export const DEFAULT_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'glm-5.2', 'glm-5.1']

// ───────────────────────── URL / 编码 ─────────────────────────

function parseUrl(urlStr) {
  const u = new URL(urlStr)
  return { host: u.host, path: u.pathname, query: u.search.length > 1 ? u.search.slice(1) : '' }
}

/** RFC3986 编码（V11 要求，比 encodeURIComponent 多转义 !'()* ） */
function rfc3986(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function canonPath(pathname) {
  const raw = pathname.length > 0 ? pathname : '/'
  const parts = raw.split('/').map((seg) => {
    try {
      return rfc3986(decodeURIComponent(seg))
    } catch {
      return rfc3986(seg)
    }
  })
  const joined = parts.join('/')
  return joined.endsWith('/') ? joined : joined + '/'
}

function canonQuery(query) {
  if (query.length === 0) return ''
  const pairs = []
  for (const part of query.split('&')) {
    if (part.length === 0) continue
    const eq = part.indexOf('=')
    pairs.push(eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)])
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&')
}

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** x-sdk-date：`20261014T013000Z` */
function dateStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

// ───────────────────────── DPoP / PKCE ─────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 生成 PKCE verifier + challenge（S256） */
export function pkcePair() {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * 生成 P-256 密钥对（DPoP 用）。返回 { privateKey, publicJwk }。
 * ⚠️ 登录时必须**本次新生成**（STS 换码会校验 `cnf.jkt`）；续期要复用凭据里存的那把。
 */
export function dpopKeyPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return { privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
}

/** 从持久化的 JWK 恢复私钥（续期时必须复用登录时那把） */
export function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: jwk, format: 'jwk' })
}

/** 生成 DPoP JWS（compact 三段式，ES256） */
export function dpopJws(privateKey, publicJwk, htm, htu) {
  const header = JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })
  const payload = JSON.stringify({
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: b64url(randomBytes(16))
  })
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  // dsaEncoding: 'ieee-p1363' 直接给出 JWS 要求的 raw R‖S（64 字节），无需 DER 转换
  const sig = createSign('sha256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(sig)}`
}

// ───────────────────────── 华为云 SDK-HMAC-SHA256 ─────────────────────────

/**
 * 生成 SDK-HMAC-SHA256 签名头（取网关密钥 / 任何 claw 侧接口都用它）。
 * @returns {Record<string,string>} 含 Authorization / x-sdk-date / x-security-token / host…
 */
export function sdkHmacHeaders(ak, sk, securityToken, method, urlStr, bodyBytes, extraHeaders) {
  const parts = parseUrl(urlStr)
  const headers = new Map()
  headers.set('host', parts.host)
  headers.set('x-sdk-date', dateStamp())
  headers.set('x-sdk-content-sha256', createHash('sha256').update(bodyBytes).digest('hex'))
  if (securityToken) headers.set('x-security-token', securityToken)
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')
  for (const [k, v] of Object.entries(extraHeaders ?? {})) headers.set(k.toLowerCase(), String(v))

  const names = [...headers.keys()].sort()
  const canonical = [
    method.toUpperCase(),
    canonPath(parts.path),
    canonQuery(parts.query),
    names.map((k) => `${k}:${headers.get(k)}`).join('\n') + '\n',
    names.join(';'),
    headers.get('x-sdk-content-sha256')
  ].join('\n')
  const stringToSign = `SDK-HMAC-SHA256\n${headers.get('x-sdk-date')}\n${createHash('sha256').update(canonical).digest('hex')}`
  const signature = hmac(sk, stringToSign).toString('hex')

  const out = {}
  for (const [k, v] of headers) out[k] = v
  out.Authorization = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${names.join(';')},Signature=${signature}`
  return out
}

// ───────────────────────── 登录 ─────────────────────────

/** 取 OAuth state（OfficeAce 要求先向 claw 申请） */
export async function fetchState(fetcher = fetch, logger) {
  const res = await fetcher(`${CLAW_BASE}/v1/claw/auth/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`OfficeAce 取 state 失败（HTTP ${res.status}）`)
  const dto = await res.json().catch((e) => {
    logger?.debug?.(`officeace: state 响应解析失败 ${String(e)}`)
    return {}
  })
  const state = typeof dto?.state === 'string' ? dto.state.trim() : ''
  if (state.length === 0) throw new Error('OfficeAce state 响应缺少 state 字段')
  return state
}

/** 组装授权地址（外层登录页，内层才是真正的 OAuth 授权请求） */
export function buildAuthorizeUrl(port, challenge, state) {
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`
  const inner = `${AUTH_BASE}/authui/v1/oauth2/authorize`
    + `?client_id=${OFFICEACE_CLIENT_ID}`
    + `&code_challenge=${challenge}`
    + `&code_challenge_method=SHA-256`
    + `&state=${state}`
    + `&scope=openid`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code`
  return `${AUTH_BASE}/authui/login.html?service=${encodeURIComponent(inner)}`
}

/** 用授权码换 STS 凭据 */
export function exchangeCode(code, verifier, port, privateKey, publicJwk, fetcher = fetch) {
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`
  return requestToken(
    {
      client_id: OFFICEACE_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    },
    privateKey,
    publicJwk,
    fetcher
  )
}

/** 用 refresh_token 续期 */
export function exchangeRefresh(refreshToken, verifier, privateKey, publicJwk, fetcher = fetch) {
  return requestToken(
    {
      client_id: OFFICEACE_CLIENT_ID,
      code_verifier: verifier,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    },
    privateKey,
    publicJwk,
    fetcher
  )
}

/** 打 STS token 端点（DPoP + 表单） */
async function requestToken(body, privateKey, publicJwk, fetcher) {
  const dpop = dpopJws(privateKey, publicJwk, 'POST', STS_ENDPOINT)
  const res = await fetcher(STS_ENDPOINT, {
    method: 'POST',
    headers: {
      DPoP: dpop,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(60000)
  })
  const text = await res.text()
  let dto
  try {
    dto = JSON.parse(text)
  } catch {
    throw new Error(`OfficeAce：STS 响应无法解析（HTTP ${res.status}）`)
  }
  return { status: res.status, dto, raw: text }
}

/** 把 STS 返回体转成凭据对象（字段名与 PC 侧实现保持一致） */
export function credentialFromTokenResponse(result, verifier, privateJwk) {
  const creds = result.dto?.credentials ?? {}
  return {
    access_key_id: creds.access_key_id ?? '',
    secret_access_key: creds.secret_access_key ?? '',
    security_token: creds.security_token ?? '',
    expires_at: creds.expiration ?? '',
    refresh_token: result.dto?.refresh_token ?? '',
    code_verifier: verifier,
    dpop_private_key_jwk: privateJwk
  }
}

/**
 * 起本机回调服务器收 `code`，返回 { loginUrl, result, close }。
 * `result` 解析为凭据对象（已含网关密钥）。
 */
export async function startOAuthFlow({ fetcher = fetch, logger } = {}) {
  const state = await fetchState(fetcher, logger)
  const { verifier, challenge } = pkcePair()
  const { privateKey, publicJwk } = dpopKeyPair()

  let resolveResult
  let rejectResult
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let settled = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(REDIRECT_PATH)) {
      res.writeHead(404).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('缺少授权码')
      return
    }
    const port = server.address().port
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<!doctype html><meta charset="utf-8"><h2>登录成功，可关闭此页。</h2>')
    exchangeCode(code, verifier, port, privateKey, publicJwk, fetcher)
      .then((r) => {
        settled = true
        server.close()
        const cred = credentialFromTokenResponse(r, verifier, privateKey.export({ format: 'jwk' }))
        return withModelInfo(cred, fetcher, logger).then(resolveResult)
      })
      .catch((e) => {
        settled = true
        server.close()
        rejectResult(e)
      })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const loginUrl = buildAuthorizeUrl(port, challenge, state)

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      server.close()
      rejectResult(new Error('OfficeAce：登录等待超时，请重试'))
    }
  }, OAUTH_TTL_MS)
  timer.unref?.()

  return {
    loginUrl,
    result: result.finally(() => clearTimeout(timer)),
    close: () => {
      settled = true
      clearTimeout(timer)
      server.close()
    }
  }
}

// ───────────────────────── 网关密钥 / 模型目录 ─────────────────────────

/** 补 scheme 并确保以 `/v2` 结尾 */
export function normalizeBase(base) {
  let value = String(base ?? '').trim().replace(/\/+$/, '')
  if (value.length === 0) return ''
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value
  if (!value.endsWith('/v2')) value += '/v2'
  return value
}

/** 网关 Basic 鉴权头值 */
export function basicAuth(appKey, appSecret) {
  return 'Basic ' + Buffer.from(`${appKey}:${appSecret}`, 'utf8').toString('base64')
}

/** 取网关密钥：POST <claw>/v1/claw/client-subscription（SDK-HMAC 签名） */
export async function fetchModelInfo(credential, fetcher = fetch) {
  const url = `${CLAW_BASE}/v1/claw/client-subscription`
  const body = '{}'
  const headers = sdkHmacHeaders(
    credential.access_key_id,
    credential.secret_access_key,
    credential.security_token,
    'POST',
    url,
    Buffer.from(body),
    { 'content-type': 'application/json;charset=utf8', 'x-subscription-type': 'v2' }
  )
  delete headers.host
  headers['Content-Type'] = 'application/json;charset=utf8'
  const res = await fetcher(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`OfficeAce 取网关密钥失败（HTTP ${res.status}）`)
  const payload = await res.json()
  const info = payload?.model_info ?? payload?.subscription?.model_info ?? payload?.data?.model_info ?? {}
  const auth = info.model_auth_info ?? {}
  const appKey = typeof auth.model_app_key === 'string' ? auth.model_app_key.trim() : ''
  const appSecret = typeof auth.model_app_secret === 'string' ? auth.model_app_secret.trim() : ''
  const base = normalizeBase(info.model_api_url_base)
  if (appKey.length === 0 || appSecret.length === 0 || base.length === 0) {
    throw new Error('OfficeAce 网关密钥不完整（缺少 model_app_key / model_app_secret / model_api_url_base）')
  }
  return { appKey, appSecret, base }
}

/** 续期/登录后补取网关密钥；失败只告警（沿用旧密钥），不阻断续期 */
export async function withModelInfo(credential, fetcher = fetch, logger) {
  try {
    const info = await fetchModelInfo(credential, fetcher)
    credential.model_app_key = info.appKey
    credential.model_app_secret = info.appSecret
    credential.model_api_url_base = info.base
  } catch (error) {
    logger?.warn?.(`officeace: 取网关密钥失败（沿用旧值）：${String(error?.message ?? error)}`)
  }
  return credential
}

/** 远端模型目录：GET <base>/models（Basic）；失败返回空数组（调用方回落 DEFAULT_MODELS） */
export async function fetchRemoteModels(credential, fetcher = fetch) {
  const base = normalizeBase(credential?.model_api_url_base)
  if (base.length === 0 || !credential?.model_app_key || !credential?.model_app_secret) return []
  try {
    const res = await fetcher(`${base}/models`, {
      method: 'GET',
      headers: {
        Authorization: basicAuth(credential.model_app_key, credential.model_app_secret),
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!res.ok) return []
    const dto = await res.json()
    const rows = Array.isArray(dto?.data) ? dto.data : Array.isArray(dto?.models) ? dto.models : []
    const out = []
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      if (id.length > 0 && !out.some((m) => m.id === id)) out.push({ id, name: id })
    }
    return out
  } catch {
    return []
  }
}

// ───────────────────────── V11-HMAC-SHA256（额度接口） ─────────────────────────

/** 网关 origin：`model_api_url_base` 去掉尾部 `/v2` */
export function apiOrigin(credential) {
  let value = String(credential?.model_api_url_base ?? '').trim()
  if (value.endsWith('/v2')) value = value.slice(0, -3)
  return value.replace(/\/+$/, '')
}

/**
 * V11 签名头。要点（与 SDK-HMAC 的差别）：
 *   scope = <yyyymmdd>/cn-southwest-2/apic
 *   stringToSign = "V11-HMAC-SHA256\n<dateStamp>\n<scope>\n<sha256(canonical)>"
 *   derived = HMAC(HMAC(ak, sk), scope‖0x01)[0:32]
 *   signature = HMAC(**hex(derived)**, stringToSign)   ← key 是 derived 的十六进制串
 */
export function v11Headers(credential, method, urlStr, extraHeaders, bodyText) {
  const parts = parseUrl(urlStr)
  const headers = {}
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  }
  const ds = dateStamp()
  headers['host'] = headers['host'] ?? parts.host
  headers['x-sdk-date'] = ds
  if (credential.security_token) headers['x-security-token'] = credential.security_token

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((k) => `${k}:${headers[k]}`).join('\n') + '\n'
  const payloadHash = sha256Hex(bodyText ?? '')
  const canonical = [
    method.toUpperCase(),
    canonPath(parts.path),
    canonQuery(parts.query),
    canonicalHeaders,
    names.join(';'),
    payloadHash
  ].join('\n')
  const scope = `${ds.slice(0, 8)}/${REGION}/apic`
  const stringToSign = ['V11-HMAC-SHA256', ds, scope, sha256Hex(canonical)].join('\n')
  const k1 = hmac(credential.access_key_id, credential.secret_access_key)
  const derived = hmac(k1, Buffer.concat([Buffer.from(scope), Buffer.from([1])])).subarray(0, 32)
  const signature = hmac(derived.toString('hex'), stringToSign).toString('hex')

  const out = { ...headers }
  out.Authorization = `V11-HMAC-SHA256 Credential=${credential.access_key_id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
  return out
}

/** 查额度：GET <origin>/v1/subscription */
export async function fetchSubscription(credential, fetcher = fetch) {
  const url = `${apiOrigin(credential)}/v1/subscription`
  const headers = v11Headers(credential, 'GET', url, { 'x-subscription-type': 'v2' }, '')
  delete headers.host
  const res = await fetcher(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`OfficeAce subscription HTTP ${res.status}`)
  return res.json()
}

/** 领每日奖励：POST <origin>/v1/subscription/bonus/claim（**必须** JSON 头 + body `{}`） */
export async function claimBonus(credential, fetcher = fetch) {
  const url = `${apiOrigin(credential)}/v1/subscription/bonus/claim`
  const body = '{}'
  const headers = v11Headers(credential, 'POST', url, { 'content-type': 'application/json' }, body)
  delete headers.host
  headers['Content-Type'] = 'application/json'
  const res = await fetcher(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`OfficeAce claim HTTP ${res.status}`)
  const data = await res.json()
  return Array.isArray(data?.bonus_skus) ? data.bonus_skus : []
}

/**
 * 汇总额度：`skus[].quotas[officeace_points]` 剩余 + `bonus_skus[]`（活动池）剩余。
 * 返回 `{ total, packages }` —— 渲染端读的是 `total`。
 */
export function mapBalance(sub) {
  const packages = []
  let total = 0
  const add = (name, limit, used, expiresAt) => {
    const quota = Number(limit)
    const usedNum = Number(used)
    const remaining = Number.isFinite(quota) ? Math.max(0, quota - (Number.isFinite(usedNum) ? usedNum : 0)) : 0
    total += remaining
    packages.push({
      name,
      total: Number.isFinite(quota) ? quota : remaining,
      ...(Number.isFinite(usedNum) ? { used: usedNum } : {}),
      ...(expiresAt ? { expiresAt } : {})
    })
  }
  for (const sku of Array.isArray(sub?.skus) ? sub.skus : []) {
    for (const q of Array.isArray(sku?.quotas) ? sku.quotas : []) {
      if (q?.sku_attr_code !== 'officeace_points') continue
      add(sku.sku_name ?? sku.sku_code ?? 'OfficeAce', q.sku_value, q.current_value, sku.expired_time ?? q.expired_time)
    }
  }
  for (const b of Array.isArray(sub?.bonus_skus) ? sub.bonus_skus : []) {
    if (b?.status !== undefined && b.status !== 'SUBSCRIBED') continue
    add(b.activity_name ?? b.activity_id ?? '活动', b.points, b.current_value, b.expired_time)
  }
  return { total, packages }
}

/** 领取结果：返回领取到的积分数；`null` = 今日无可领 */
export function claimedPoints(skus) {
  if (!Array.isArray(skus) || skus.length === 0) return null
  return skus.reduce((sum, s) => sum + (Number(s?.points) || 0), 0)
}
