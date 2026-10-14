/**
 * dsh-officeace —— 果办OfficeAce（华为云 AgentArts）渠道，只此一条渠道。
 *
 * 为什么单独做一个包：打在上游 `dsh-our-free-model` 里时，插件每次自更新都会覆盖
 * `pack.js`/`client.js` 把渠道抹掉，且上游换构建后锚点全失效。本包只依赖 dsh 的内核契约
 * （`ctx.llm` / `ctx.credentials` / `ctx.webServer`），不依赖任何上游插件。
 *
 * 两半：
 *   - 宿主（本文件）：注册 provider `officeace`（模型进模型选择器即可对话）、
 *     多账号池（`./accounts.js`）、每 30 分钟定时续期、以及给界面用的同源路由 `/api/officeace/*`。
 *   - 浏览器（`../client.js`）：dsh 设置里的「果办OfficeAce」卡片（账号列表 / 模型开关 / 积分 / 领取）。
 *
 * ⚠️ 纯逆向实现：OfficeAce 客户端 / 华为云 MaaS 一改就可能失效（协议层见 ./protocol.js）。
 *
 * @module dsh-officeace
 */

import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import * as proto from './protocol.js'
import { AccountStore } from './accounts.js'

export const name = 'officeace'
/** 只硬注入 llm；credentials / webServer 走 ctx.get 与 ctx.inject，缺了也只是少对应能力。 */
export const inject = ['llm']

const PROVIDER = 'officeace'
/** 续期提前量：距过期不足 1 小时就续 */
const REFRESH_LEAD_MS = 60 * 60 * 1000
/** 定时续期间隔 */
const RENEW_INTERVAL_MS = 30 * 60 * 1000
/** 默认输出上限 */
const DEFAULT_MAX_TOKENS = 65536
/** 一次请求最多换几个账号 */
const MAX_ROTATE = 3

const REASONING_ON = ReasoningEffortId('on')
const REASONING_OFF = ReasoningEffortId('off')

export const Config = z.object({
  /** 默认输出上限 */
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS)
})

// ───────────────────────── 凭据：有效期 / 续期 ─────────────────────────

function expiryMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isRefreshable(credential) {
  return Boolean(credential?.refresh_token && credential?.code_verifier && credential?.dpop_private_key_jwk)
}

function needsRefresh(credential) {
  const exp = expiryMs(credential)
  return exp === undefined || exp - Date.now() <= REFRESH_LEAD_MS
}

/** 全局续期链：`refresh_token` 一次性，多入口并发会报 STS5.1806 */
let refreshChain = Promise.resolve()

/** 用 refresh_token 换新凭据（并补取网关密钥） */
function refreshCredential(credential, logger, fetchImpl) {
  const task = refreshChain.then(async () => {
    if (!isRefreshable(credential)) {
      throw new Error('缺少续期材料（refresh_token / code_verifier / DPoP 私钥），请重新登录')
    }
    const jwk = credential.dpop_private_key_jwk
    const privateKey = proto.privateKeyFromJwk(jwk)
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
    const result = await proto.exchangeRefresh(credential.refresh_token, credential.code_verifier, privateKey, publicJwk, fetchImpl)
    if (result.status !== 200) {
      const code = result.dto?.error_code ?? ''
      const desc = result.dto?.error_description ?? result.dto?.error ?? ''
      const terminal = result.dto?.error === 'invalid_grant'
        || code === 'STS5.1806'
        || String(code).includes('ExpiredRefreshToken')
        || String(desc).includes('has been used')
      throw new Error(terminal
        ? `refresh_token 已失效（${code || 'invalid_grant'}），请重新登录`
        : `STS 续期失败（HTTP ${result.status} ${code} ${desc}）`)
    }
    const next = proto.credentialFromTokenResponse(result, credential.code_verifier, privateKey.export({ format: 'jwk' }))
    if (!next.refresh_token) next.refresh_token = credential.refresh_token
    next.model_app_key = credential.model_app_key
    next.model_app_secret = credential.model_app_secret
    next.model_api_url_base = credential.model_api_url_base
    return await proto.withModelInfo(next, fetchImpl, logger)
  })
  refreshChain = task.then(() => {}).catch(() => {})
  return task
}

// ───────────────────────── wire 转换 ─────────────────────────

/** harness 消息 → OpenAI 形状（工具历史折成文本，兼容面最广） */
function toOpenAiMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    const parts = []
    for (const block of message?.content ?? []) {
      if (block?.type === 'text') parts.push(block.text ?? '')
      else if (block?.type === 'image') parts.push('[image omitted]')
      else if (block?.type === 'tool-call') parts.push(`[called ${block.name}(${block.arguments ?? ''})]`)
      else if (block?.type === 'tool-result') {
        const inner = (block.content ?? []).map((c) => (c?.type === 'text' ? c.text : '')).join('')
        parts.push(`[tool result${block.isError ? ' (error)' : ''}] ${inner}`)
      }
    }
    const content = parts.filter((s) => typeof s === 'string' && s.length > 0).join('\n')
    if (content.length === 0) continue
    out.push({ role: message.role, content })
  }
  return out
}

/** 解析 SSE 流，逐条吐出 `data:` 负载 */
async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (text) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim()
    }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')
    for (;;) {
      const idx = buffer.indexOf('\n\n')
      if (idx < 0) break
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      yield* drain(frame)
    }
  }
  if (buffer.trim().length > 0) yield* drain(buffer)
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/** wire usage → harness TokenUsage。⚠️ 网关的 prompt_tokens **含**缓存命中，harness 要求不相交 */
function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage?.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage?.completion_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
  }
}

// ───────────────────────── 适配器 ─────────────────────────

class OfficeAceAdapter extends LlmAdapter {
  constructor({ accounts, fetchImpl, logger, config }) {
    super()
    this.accounts = accounts
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.config = config
  }

  providerInfo(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: '果办OfficeAce' }
  }

  /** 完整目录（**不**过滤黑名单）：界面要能看到被关掉的模型才关得回来 */
  async catalog() {
    const usable = await this.accounts.firstUsable()
    if (usable === undefined) return []
    const remote = await proto.fetchRemoteModels(usable.credential, this.fetchImpl)
    return remote.length > 0 ? remote : proto.DEFAULT_MODELS.map((id) => ({ id, name: id }))
  }

  /** 交给 dsh 模型选择器的清单：**按渠道黑名单过滤**，关掉的模型即从这里消失 */
  async listModels(_provider, _signal) {
    const rows = await this.catalog()
    const disabled = new Set(this.accounts.disabledModels())
    return rows
      .filter((m) => !disabled.has(m.id))
      .map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] }))
  }

  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: REASONING_ON, name: '开启' },
          { id: REASONING_OFF, name: '关闭' }
        ],
        defaultEffort: REASONING_ON
      }
    }
  }

  /** 读该账号的凭据；过期就续期并回写 */
  async usableCredential(account, credential) {
    if (!needsRefresh(credential)) return credential
    try {
      const next = await refreshCredential(credential, this.logger, this.fetchImpl)
      await this.accounts.writeCredential(account, next)
      this.logger?.info?.(`officeace: 账号 ${account.id} 已续期，到期 ${next.expires_at}`)
      return next
    } catch (error) {
      this.logger?.warn?.(`officeace: 账号 ${account.id} 续期失败：${String(error?.message ?? error)}`)
      return credential
    }
  }

  /**
   * 流式对话：**多账号轮换**。
   * ⚠️ 只有**还没吐出任何内容**时才换号 —— 一旦给下游发过块，就只能把错误抛出去。
   */
  async *stream(options) {
    const all = []
    const limited = []
    const now = Date.now()
    for (const account of this.accounts.list()) {
      if (account.enabled !== true) continue
      // 按模型限流记账：该账号对这个模型还在冷却里就跳过
      if (this.accounts.isLimited(account.id, options.model, now)) {
        limited.push(account.id)
        continue
      }
      const credential = await this.accounts.readCredential(account)
      if (credential !== undefined) all.push({ account, credential })
    }
    if (all.length === 0) {
      if (limited.length > 0) {
        const until = Math.max(...limited.map((id) => this.accounts.limitedUntil(id, now)))
        throw new LlmError(
          `officeace: 模型 ${options.model} 的可用账号均在限流中，最近一个将于 ${new Date(until).toLocaleString()} 解禁`,
          'RATE_LIMIT'
        )
      }
      throw new LlmError('officeace: 没有可用账号（未登录，或在「果办OfficeAce」卡片里被停用了）', 'MISSING_CREDENTIAL')
    }

    let lastError
    let index = 0
    for (const candidate of all) {
      if (index >= MAX_ROTATE) break
      index += 1
      const credential = await this.usableCredential(candidate.account, candidate.credential)
      if (credential === undefined || !credential.model_app_key || !credential.model_app_secret) continue
      let emitted = false
      try {
        for await (const chunk of this.callOnce(options, credential)) {
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (emitted) throw error
        lastError = error
        // 额度/限流类失败 → 记账，之后这个账号对该模型进入冷却
        if (isQuotaFailure(error)) {
          const resetAt = parseResetAt(String(error?.message ?? '')) ?? nextUtc8DayStartMs()
          this.accounts.recordRateLimit(candidate.account.id, options.model, resetAt)
          this.logger?.warn?.(`officeace: 账号 ${candidate.account.id} 对 ${options.model} 限流，记到 ${new Date(resetAt).toLocaleString()}`)
        }
        this.logger?.warn?.(`officeace: 账号 ${candidate.account.id} 失败（换下一个）：${String(error?.message ?? error)}`)
      }
    }
    throw lastError ?? new LlmError('officeace: 所有账号都不可用', 'MISSING_CREDENTIAL')
  }

  /** 用一份凭据发一次请求；401/403 时续期一次再试 */
  async *callOnce(options, credential) {
    const messages = []
    if (typeof options.system === 'string' && options.system.length > 0) {
      messages.push({ role: 'system', content: options.system })
    }
    messages.push(...toOpenAiMessages(options.messages))
    const tools = (options.tools ?? []).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      prompt_cache_key: options.sessionId,
      include: ['reasoning.encrypted_content'],
      reasoning_summary: 'auto',
      ...(options.reasoningEffort === REASONING_OFF ? { thinking: { type: 'disabled' } } : {}),
      tool_stream: true,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      ...(tools.length > 0 ? { tools } : {})
    })
    const url = `${proto.normalizeBase(credential.model_api_url_base)}/chat/completions`
    const headersFor = (cred) => ({
      ...(attributionHeaders() ?? {}),
      Authorization: proto.basicAuth(cred.model_app_key, cred.model_app_secret),
      'Content-Type': 'application/json',
      lang: 'en'
    })

    let response = await this.fetchImpl(url, { method: 'POST', headers: headersFor(credential), body, signal: options.signal })
    if (response.status === 401 || response.status === 403) {
      const detail = await response.text().catch(() => '')
      let refreshed
      try {
        refreshed = await refreshCredential(credential, this.logger, this.fetchImpl)
      } catch (error) {
        throw new LlmError(`officeace: 鉴权失败且续期未成功：${String(error?.message ?? error)}`, 'AUTH')
      }
      response = await this.fetchImpl(url, { method: 'POST', headers: headersFor(refreshed), body, signal: options.signal })
      if (!response.ok) {
        throw new LlmError(`officeace: 请求失败（HTTP ${response.status}）${detail.length > 0 ? ': ' + detail.slice(0, 200) : ''}`, 'AUTH')
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `officeace: 请求失败（HTTP ${response.status}）${detail.length > 0 ? ': ' + detail.slice(0, 200) : ''}`,
        response.status === 429 ? 'RATE_LIMIT' : 'SERVER'
      )
    }
    if (response.body === null) throw new LlmError('officeace: 响应没有 body', 'EMPTY_RESPONSE')
    yield* this.translate(parseSse(response.body))
  }

  /** SSE 负载 → harness StreamChunk（契约见 dsh-llm 的 StreamChunk 联合） */
  async *translate(payloads) {
    let nextIndex = 0
    const order = []
    let reasoningBlock
    let textBlock
    const toolBlocks = new Map()
    let pendingFinish
    let pendingUsage
    const open = (kind) => {
      const block = { index: nextIndex++, kind, text: '' }
      order.push(block)
      return block
    }
    const closeBlock = (block) => {
      if (block.kind === 'text') return { type: 'text', text: block.text }
      if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
      return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
    }

    for await (const payload of payloads) {
      if (payload === '[DONE]') {
        for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
        const reason = pendingFinish ?? { kind: 'stop' }
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
            : reason
        }
        return
      }
      let chunk
      try {
        chunk = JSON.parse(payload)
      } catch {
        throw new LlmError(`officeace: SSE 负载不是合法 JSON：${String(payload).slice(0, 120)}`, 'MALFORMED_RESPONSE')
      }
      if (chunk?.error !== undefined && chunk.error !== null) {
        throw new LlmError(
          `officeace: ${chunk.error.message ?? '模型服务返回错误'}`,
          typeof chunk.error.code === 'string' && chunk.error.code.length > 0 ? chunk.error.code : 'SERVER'
        )
      }
      for (const choice of chunk?.choices ?? []) {
        const delta = choice?.delta
        const reasoning = delta?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          if (reasoningBlock === undefined) {
            reasoningBlock = open('reasoning')
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += reasoning
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
        }
        const content = delta?.content
        if (typeof content === 'string' && content.length > 0) {
          if (textBlock === undefined) {
            textBlock = open('text')
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += content
          yield { type: 'text-delta', index: textBlock.index, text: content }
        }
        for (const call of delta?.tool_calls ?? []) {
          const key = call?.index ?? 0
          let block = toolBlocks.get(key)
          if (block === undefined) {
            block = open('tool-call')
            toolBlocks.set(key, block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (typeof call?.id === 'string' && call.id.length > 0) block.callId = call.id
          if (typeof call?.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
          const args = call?.function?.arguments
          if (typeof args === 'string' && args.length > 0) {
            block.text += args
            yield { type: 'tool-call-delta', index: block.index, id: block.callId, name: block.name, argumentsDelta: args }
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
          pendingFinish = mapFinishReason(choice.finish_reason)
        }
      }
      if (chunk?.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
    }
  }
}

// ───────────────────────── 小工具 ─────────────────────────

function fmtInt(value) {
  return Math.round(Number(value) || 0).toString()
}

/** UTC+8 当日 24:00（按自然日结算的额度重置点）——与插件的 nextUtc8DayStart 同口径 */
function nextUtc8DayStartMs(now = Date.now()) {
  const offset = 8 * 3600000
  const shifted = now + offset
  const msIntoDay = ((shifted % 86400000) + 86400000) % 86400000
  return now + (86400000 - msIntoDay)
}

/** 从错误正文里解析解禁时刻（`将在 2026-10-05 12:00:00 UTC+8` 这种）；解析不出返回 undefined */
function parseResetAt(text, now = Date.now()) {
  const match = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i.exec(text ?? '')
  if (match !== null) {
    const parsed = Date.parse(`${match[1]} ${match[2]}`)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 是否限流/额度类失败（决定要不要记账） */
function isQuotaFailure(error) {
  if (error?.code === 'RATE_LIMIT') return true
  return /配额|额度|积分不足|不足|quota|insufficient|超出限制|频率|rate.?limit|too many requests/i.test(String(error?.message ?? ''))
}

function openExternal(url, logger) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => logger?.warn?.(`officeace: 打开浏览器失败 ${String(error)}`))
    child.unref()
  } catch (error) {
    logger?.warn?.(`officeace: 打开浏览器失败 ${String(error)}`)
  }
}

function describeCredential(credential) {
  const exp = expiryMs(credential)
  return `access_key ${credential?.access_key_id ?? '(空)'} · 到期 ${exp === undefined ? '未知' : new Date(exp).toLocaleString()}`
}

// ───────────────────────── 界面用的同源路由 ─────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 把数据端点挂到 dsh 的 web 服务上（与界面同源），供浏览器半身 fetch。
 *
 * ⚠️ **必须用 `ctx.inject(['webServer'], …)`，不能在 apply 时 `ctx.get('webServer')` 取一次**：
 * 真实 web 组合里插件先于 browser 半身加载，那一刻 `webServer` 还没提供 —— 取到 undefined，
 * 路由就永远不注册，界面拿到的是 dsh 默认的 404（表现为卡片上「登录发起失败：not found」）。
 */
function registerRoutes(ctx, accounts, adapter, logger, fetchImpl) {
  if (typeof ctx.inject !== 'function') {
    logger?.warn?.('officeace: ctx.inject 不可用，界面数据端点未挂载')
    return
  }

  /** 账号行（给界面用，不带凭据本体） */
  const accountRow = async (account) => {
    const credential = await accounts.readCredential(account)
    return {
      id: account.id,
      nickname: account.nickname ?? '',
      enabled: account.enabled === true,
      accessKey: credential?.access_key_id ?? '',
      expiresAt: credential === undefined ? null : (expiryMs(credential) ?? null),
      refreshable: credential !== undefined && isRefreshable(credential),
      /** 该账号当前被限流的最晚解禁时刻（0 = 未限流） */
      limitedUntil: accounts.limitedUntil(account.id),
      /** 上次取网关密钥失败的原因（空 = 正常）；界面直接显示，省得只看到"缺少网关地址" */
      modelInfoError: credential?.model_info_error ?? ''
    }
  }

  const modelsPayload = async () => {
    const rows = await adapter.catalog()
    const disabled = new Set(accounts.disabledModels())
    const items = rows.map((m) => ({ id: m.id, name: m.name ?? m.id, disabled: disabled.has(m.id) }))
    return { items, total: items.length, enabled: items.filter((m) => !m.disabled).length, loggedIn: rows.length > 0 }
  }

  /**
   * 界面的**完整**状态：账号 + 模型 + 登录会话。
   * ⚠️ 所有会改动状态的端点都必须返回**这一整份** —— 客户端拿它整体覆盖本地状态。
   * 曾经模型开关只返回模型那一段，客户端一覆盖就把 `accounts` 抹掉，
   * 表现为「切换模型后账号列表和积分区一起消失」。
   */
  const statusPayload = async () => {
    const rows = []
    for (const account of accounts.list()) rows.push(await accountRow(account))
    return { accounts: rows, models: await modelsPayload(), login: accounts.login() ?? null }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/api\/officeace/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const accountMatch = /^\/accounts\/([^/]+)(?:\/([a-z]+))?$/.exec(route)

    try {
      // 总览：账号列表 + 模型清单（一次往返拿全，界面刷新只发一个请求）
      if (method === 'GET' && route === '/status') {
        return send(200, await statusPayload())
      }

      // 新增账号：起 OAuth，回调完成后落库为 N 号账号。
      // ⚠️ 结果写进账号池（不是只进日志）—— dsh 不落应用日志，界面否则看不到失败原因。
      if (method === 'POST' && route === '/login') {
        const slot = accounts.nextRef()
        accounts.setLogin({ status: 'pending', accountId: slot.id, startedAt: Date.now() })
        let flow
        try {
          flow = await proto.startOAuthFlow({ fetcher: fetchImpl, logger })
        } catch (error) {
          accounts.setLogin({ status: 'failed', error: String(error?.message ?? error), finishedAt: Date.now() })
          throw error
        }
        flow.result
          .then(async (credential) => {
            accounts.add({ id: slot.id, ref: slot.ref })
            await accounts.writeCredential({ id: slot.id, ref: slot.ref }, credential)
            accounts.setLogin({ status: 'ok', accountId: slot.id, finishedAt: Date.now() })
            logger?.info?.(`officeace: 账号 ${slot.id} 登录成功（${describeCredential(credential)}）`)
          })
          .catch((error) => {
            const message = String(error?.message ?? error)
            accounts.setLogin({ status: 'failed', error: message, finishedAt: Date.now() })
            logger?.warn?.(`officeace: 登录失败 ${message}`)
          })
        openExternal(flow.loginUrl, logger)
        return send(200, { loginUrl: flow.loginUrl, accountId: slot.id })
      }

      // 账号级操作：启用/停用、续期、移除、连通测试
      if (accountMatch !== null) {
        const account = accounts.get(accountMatch[1])
        if (account === undefined) return send(404, { error: '账号不存在' })
        const action = accountMatch[2] ?? ''

        if (method === 'POST' && action === 'enable') {
          const body = await readJson(req)
          accounts.setEnabled(account.id, body.enabled === true)
          return send(200, { ok: true, account: await accountRow(account) })
        }
        if (method === 'POST' && action === 'refresh') {
          const credential = await accounts.readCredential(account)
          if (credential === undefined) return send(409, { error: '该账号没有凭据' })
          const next = await refreshCredential(credential, logger, fetchImpl)
          await accounts.writeCredential(account, next)
          return send(200, { ok: true, account: await accountRow(account) })
        }
        if (method === 'POST' && action === 'remove') {
          await accounts.remove(account.id)
          return send(200, { ok: true })
        }
        if (method === 'GET' && action === 'test') {
          const credential = await accounts.readCredential(account)
          if (credential === undefined) return send(409, { error: '该账号没有凭据' })
          const started = Date.now()
          try {
            // 用严格版：失败要说出原因，别报成「连接正常（0 个模型）」
            const models = await proto.fetchRemoteModelsStrict(credential, fetchImpl)
            return send(200, { ok: true, models: models.length, ms: Date.now() - started })
          } catch (error) {
            return send(200, { ok: false, error: String(error?.message ?? error), ms: Date.now() - started })
          }
        }
        return send(404, { error: `未知的账号操作 ${action}` })
      }

      // 模型开关（渠道级黑名单）—— 返回**完整状态**，别让客户端把账号抹掉
      if (method === 'POST' && route === '/models/disable') {
        const body = await readJson(req)
        if (typeof body.model !== 'string' || body.model.length === 0) return send(400, { error: '缺少 model' })
        accounts.setModelDisabled(body.model, body.disabled === true)
        return send(200, await statusPayload())
      }
      if (method === 'POST' && route === '/models/disableAll') {
        const body = await readJson(req)
        const rows = await adapter.catalog()
        accounts.setAllModelsDisabled(rows.map((m) => m.id), body.disabled === true)
        return send(200, await statusPayload())
      }

      // 积分：逐账号查（串行，避免风控），返回每个账号的分项与合计
      if (method === 'GET' && route === '/credits') {
        const rows = []
        let total = 0
        let anyAmount = false
        for (const account of accounts.list()) {
          const credential = await accounts.readCredential(account)
          if (credential === undefined) {
            rows.push({ id: account.id, nickname: account.nickname ?? '', ok: false, total: 0, packages: [], error: '凭据缺失' })
            continue
          }
          if (typeof credential.model_api_url_base !== 'string' || credential.model_api_url_base.length === 0) {
            rows.push({ id: account.id, nickname: account.nickname ?? '', ok: false, total: 0, packages: [], error: '凭据缺少网关地址——点该账号「续期」或重新登录' })
            continue
          }
          try {
            const balance = proto.mapBalance(await proto.fetchSubscription(credential, fetchImpl))
            total += balance.total
            anyAmount = true
            rows.push({ id: account.id, nickname: account.nickname ?? '', ok: true, total: balance.total, packages: balance.packages })
          } catch (error) {
            rows.push({ id: account.id, nickname: account.nickname ?? '', ok: false, total: 0, packages: [], error: String(error?.message ?? error) })
          }
        }
        return send(200, { accounts: rows, total: anyAmount ? total : 0 })
      }

      // 领取：逐账号领，汇总
      if (method === 'POST' && route === '/claim') {
        const rows = []
        let claimed = 0
        for (const account of accounts.list()) {
          if (account.enabled !== true) continue
          const credential = await accounts.readCredential(account)
          if (credential === undefined) continue
          if (typeof credential.model_api_url_base !== 'string' || credential.model_api_url_base.length === 0) {
            rows.push({ id: account.id, kind: 'failed', credit: 0, message: '凭据缺少网关地址——点该账号「续期」或重新登录' })
            continue
          }
          try {
            const points = proto.claimedPoints(await proto.claimBonus(credential, fetchImpl))
            if (points === null) rows.push({ id: account.id, kind: 'already', credit: 0, message: '今日无可领奖励' })
            else {
              claimed += points
              rows.push({ id: account.id, kind: 'claimed', credit: points, message: `已领取 +${fmtInt(points)}` })
            }
          } catch (error) {
            rows.push({ id: account.id, kind: 'failed', credit: 0, message: String(error?.message ?? error) })
          }
        }
        return send(200, { accounts: rows, claimed })
      }

      return send(404, { error: `未知路由 ${method} ${route}` })
    } catch (error) {
      const message = String(error?.message ?? error)
      logger?.warn?.(`officeace: ${method} ${route} 失败：${message}`)
      return send(500, { error: message })
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    if (server === undefined || typeof server.register !== 'function') {
      logger?.warn?.('officeace: webServer 没有 register，界面数据端点未挂载')
      return
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/officeace', handler }), 'officeace: api routes')
    logger?.info?.('officeace: 界面数据端点已挂载 /api/officeace')
  })
}

// 供离线自检驱动（tools/selftest.mjs）：把 (req,res) 换成 mock 即可跑，不需要 dsh
export { registerRoutes, OfficeAceAdapter }

// ───────────────────────── 插件入口 ─────────────────────────

export function apply(ctx, config) {
  const accounts = new AccountStore(ctx, ctx.logger)
  const fetchImpl = (...args) => fetch(...args)
  const logger = ctx.logger

  void accounts.adoptLegacy()

  const adapter = new OfficeAceAdapter({ accounts, fetchImpl, logger, config })
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  logger?.info?.(`officeace: 渠道已注册（provider "${PROVIDER}"）`)

  registerRoutes(ctx, accounts, adapter, logger, fetchImpl)

  // 定时续期：凭据是 ~2 小时的 STS 临时凭据，靠 refresh_token 续。
  // ⚠️ refresh_token 一次性，所以只在这一个定时器里续（对话路径只在 401 时补一次）。
  const timer = setInterval(() => {
    void (async () => {
      for (const account of accounts.list()) {
        const credential = await accounts.readCredential(account)
        if (credential === undefined || !needsRefresh(credential) || !isRefreshable(credential)) continue
        try {
          const next = await refreshCredential(credential, logger, fetchImpl)
          await accounts.writeCredential(account, next)
          logger?.info?.(`officeace: 账号 ${account.id} 定时续期完成，到期 ${next.expires_at}`)
        } catch (error) {
          logger?.warn?.(`officeace: 账号 ${account.id} 定时续期失败：${String(error?.message ?? error)}`)
        }
      }
    })()
  }, RENEW_INTERVAL_MS)
  timer.unref?.()

  ctx.effect?.(() => () => {
    clearInterval(timer)
    registration()
  })
}
