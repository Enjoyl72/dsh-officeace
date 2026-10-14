/**
 * dsh-officeace —— 果办OfficeAce（华为云 AgentArts）渠道，只此一条渠道。
 *
 * 为什么单独做一个包：把它打在上游 `dsh-our-free-model` 里时，插件每次自更新都会覆盖
 * `pack.js`/`client.js` 把渠道抹掉，且上游换构建后锚点全部失效。本包只依赖 dsh 的内核
 * 契约（`ctx.llm` / `ctx.credentials` / `ctx.commands`），不依赖任何上游插件。
 *
 * 形态：**只做宿主半身**（没有浏览器半身）。渠道注册后模型会出现在 dsh 的模型选择器里、
 * 可直接对话；登录 / 积分 / 领取走斜杠命令（dsh 没有给"账号登录式渠道"预留 UI 位）。
 *
 *   /officeace login     浏览器完成华为云授权（自动打开，并给出链接兜底）
 *   /officeace status    登录态与凭据到期时间
 *   /officeace models    当前渠道可见的模型
 *   /officeace credits   积分明细（含活动池）
 *   /officeace claim     领取每日奖励
 *   /officeace logout    清除本机凭据
 *
 * ⚠️ 纯逆向实现：OfficeAce 客户端 / 华为云 MaaS 一改就可能失效（协议层见 ./protocol.js）。
 *
 * @module dsh-officeace
 */

import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import * as proto from './protocol.js'

export const name = 'officeace'
/** 只硬注入 llm；credentials/commands 走 ctx.get，缺了也只是少对应能力，不让插件挂载失败。 */
export const inject = ['llm']

/** 本插件拥有的唯一 provider 路由 */
const PROVIDER = 'officeace'
/** 凭据引用（必须是 POSIX shell 标识符） */
const DEFAULT_CRED_REF = 'OFFICEACE_ACCESS_KEY_ID'
/** 续期提前量：距过期不足 1 小时就续 */
const REFRESH_LEAD_MS = 60 * 60 * 1000
/** 定时续期间隔 */
const RENEW_INTERVAL_MS = 30 * 60 * 1000
/** 默认输出上限 */
const DEFAULT_MAX_TOKENS = 65536

const REASONING_ON = ReasoningEffortId('on')
const REASONING_OFF = ReasoningEffortId('off')

export const Config = z.object({
  /** 凭据引用名（可用 dsh 的凭据服务改） */
  credentialRef: z.string().role('credential-ref').default(DEFAULT_CRED_REF),
  /** 默认输出上限 */
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS)
})

// ───────────────────────── 凭据：读 / 续期 ─────────────────────────

function parseCredential(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function expiryMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isRefreshable(credential) {
  return Boolean(credential?.refresh_token && credential?.code_verifier && credential?.dpop_private_key_jwk)
}

/** 全局续期链：`refresh_token` 一次性，多入口并发会报 STS5.1806 */
let refreshChain = Promise.resolve()

/**
 * 用 refresh_token 换新凭据（并补取网关密钥）。
 * @returns 新凭据；不可续期时抛错
 */
function refreshCredential(credential, logger, fetchImpl) {
  const task = refreshChain.then(async () => {
    if (!isRefreshable(credential)) {
      throw new Error('缺少续期材料（refresh_token / code_verifier / DPoP 私钥），请重新登录')
    }
    const privateKey = proto.privateKeyFromJwk(credential.dpop_private_key_jwk)
    const publicJwk = {
      kty: credential.dpop_private_key_jwk.kty,
      crv: credential.dpop_private_key_jwk.crv,
      x: credential.dpop_private_key_jwk.x,
      y: credential.dpop_private_key_jwk.y
    }
    const result = await proto.exchangeRefresh(
      credential.refresh_token,
      credential.code_verifier,
      privateKey,
      publicJwk,
      fetchImpl
    )
    if (result.status !== 200) {
      const code = result.dto?.error_code ?? ''
      const desc = result.dto?.error_description ?? result.dto?.error ?? ''
      const terminal = result.dto?.error === 'invalid_grant'
        || code === 'STS5.1806'
        || String(code).includes('ExpiredRefreshToken')
        || String(desc).includes('has been used')
      throw new Error(
        terminal
          ? `refresh_token 已失效（${code || 'invalid_grant'}），请重新登录`
          : `STS 续期失败（HTTP ${result.status} ${code} ${desc}）`
      )
    }
    const next = proto.credentialFromTokenResponse(
      result,
      credential.code_verifier,
      privateKey.export({ format: 'jwk' })
    )
    if (!next.refresh_token) next.refresh_token = credential.refresh_token
    next.model_app_key = credential.model_app_key
    next.model_app_secret = credential.model_app_secret
    next.model_api_url_base = credential.model_api_url_base
    return await proto.withModelInfo(next, fetchImpl, logger)
  })
  // 链本身不被一次失败打断
  refreshChain = task.then(() => {}).catch(() => {})
  return task
}

/** 读写凭据的小门面（credentials 服务缺失时退化为"未登录"） */
class CredentialStore {
  constructor(ctx, ref) {
    this.ctx = ctx
    this.ref = ref
  }
  get service() {
    return this.ctx.get('credentials')
  }
  async read() {
    const service = this.service
    if (service === undefined) return undefined
    const hit = await service.resolve(this.ref)
    return hit === undefined ? undefined : parseCredential(hit.value)
  }
  async write(credential) {
    const service = this.service
    if (service === undefined) throw new Error('dsh 的凭据服务不可用，无法保存登录态')
    await service.set(this.ref, JSON.stringify(credential))
  }
  async clear() {
    const service = this.service
    if (service === undefined) return
    if (typeof service.unset === 'function') await service.unset(this.ref)
    else if (typeof service.delete === 'function') await service.delete(this.ref)
  }
  /** 读取并按需续期；返回 { credential, refreshed } */
  async readFresh(logger, fetchImpl) {
    let credential = await this.read()
    if (credential === undefined) return { credential: undefined, refreshed: false }
    const exp = expiryMs(credential)
    const needs = exp !== undefined && exp - Date.now() <= REFRESH_LEAD_MS
    if (!needs) return { credential, refreshed: false }
    try {
      const next = await refreshCredential(credential, logger, fetchImpl)
      await this.write(next)
      logger?.info?.(`officeace: 已续期，到期 ${next.expires_at}`)
      return { credential: next, refreshed: true }
    } catch (error) {
      logger?.warn?.(`officeace: 续期失败：${String(error?.message ?? error)}`)
      return { credential, refreshed: false }
    }
  }
}

// ───────────────────────── wire 转换 ─────────────────────────

/** harness 消息 → OpenAI 形状（工具历史折成文本，兼容面最广） */
function toOpenAiMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    const parts = []
    for (const block of message?.content ?? []) {
      if (block?.type === 'text') {
        parts.push(block.text ?? '')
      } else if (block?.type === 'image') {
        parts.push('[image omitted]')
      } else if (block?.type === 'tool-call') {
        parts.push(`[called ${block.name}(${block.arguments ?? ''})]`)
      } else if (block?.type === 'tool-result') {
        const inner = (block.content ?? []).map((c) => (c?.type === 'text' ? c.text : '')).join('')
        parts.push(`[tool result${block.isError ? ' (error)' : ''}] ${inner}`)
      }
      // reasoning 不回传
    }
    const content = parts.filter((s) => typeof s === 'string' && s.length > 0).join('\n')
    if (content.length === 0) continue
    out.push({ role: message.role, content })
  }
  return out
}

/** 解析 SSE 流，逐条吐出 `data:` 负载（`[DONE]` 也照吐，由消费者判断） */
async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')
    for (;;) {
      const idx = buffer.indexOf('\n\n')
      if (idx < 0) break
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of frame.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim()
      }
    }
  }
  const tail = buffer.trim()
  if (tail.length > 0) {
    for (const line of tail.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim()
    }
  }
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
  constructor({ store, fetchImpl, logger, config }) {
    super()
    this.store = store
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.config = config
  }

  providerInfo(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: '果办OfficeAce' }
  }

  async listModels(_provider, _signal) {
    const { credential } = await this.store.readFresh(this.logger, this.fetchImpl)
    let rows = []
    if (credential !== undefined) rows = await proto.fetchRemoteModels(credential, this.fetchImpl)
    if (rows.length === 0) rows = proto.DEFAULT_MODELS.map((id) => ({ id, name: id }))
    return rows.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] }))
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

  async *stream(options) {
    const { credential } = await this.store.readFresh(this.logger, this.fetchImpl)
    if (credential === undefined || !credential.model_app_key || !credential.model_app_secret) {
      throw new LlmError(
        `officeace: 尚未登录（或凭据缺少网关密钥）。先在 dsh 里执行 /officeace login`,
        'MISSING_CREDENTIAL'
      )
    }

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
    const headers = {
      ...(attributionHeaders() ?? {}),
      Authorization: proto.basicAuth(credential.model_app_key, credential.model_app_secret),
      'Content-Type': 'application/json',
      lang: 'en'
    }

    let response = await this.fetchImpl(url, { method: 'POST', headers, body, signal: options.signal })
    if (response.status === 401 || response.status === 403) {
      // 鉴权失败：续期一次再试（凭据可能是他处发的、这边还没拿到）
      const detail = await response.text().catch(() => '')
      const refreshed = await refreshCredential(credential, this.logger, this.fetchImpl).catch((error) => {
        throw new LlmError(`officeace: 鉴权失败且续期未成功：${String(error?.message ?? error)}`, 'AUTH')
      })
      await this.store.write(refreshed)
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, Authorization: proto.basicAuth(refreshed.model_app_key, refreshed.model_app_secret) },
        body,
        signal: options.signal
      })
      if (!response.ok) {
        throw new LlmError(
          `officeace: 请求失败（HTTP ${response.status}）${detail.length > 0 ? ': ' + detail.slice(0, 200) : ''}`,
          'AUTH'
        )
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `officeace: 请求失败（HTTP ${response.status}）${detail.length > 0 ? ': ' + detail.slice(0, 200) : ''}`,
        response.status === 429 ? 'RATE_LIMIT' : 'SERVER'
      )
    }
    if (response.body === null) {
      throw new LlmError('officeace: 响应没有 body', 'EMPTY_RESPONSE')
    }

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
          let block = toolBlocks.get(call?.index ?? 0)
          if (block === undefined) {
            block = open('tool-call')
            block.callId = call?.id ?? ''
            block.name = call?.function?.name ?? ''
            toolBlocks.set(call?.index ?? 0, block)
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

// ───────────────────────── 命令 ─────────────────────────

function fmtInt(value) {
  return Math.round(Number(value) || 0).toString()
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
  const when = exp === undefined ? '未知' : new Date(exp).toLocaleString()
  const key = typeof credential?.access_key_id === 'string' ? credential.access_key_id : ''
  return `已登录 · access_key ${key || '(空)'} · 到期 ${when}`
}

/** 注册 `/officeace <子命令>` */
function registerCommands(ctx, store, logger, fetchImpl, config) {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    logger?.warn?.('officeace: commands 服务不可用，登录/积分命令未注册（渠道本身仍可用）')
    return
  }
  commands.register({
    name: 'officeace',
    description: '果办OfficeAce：login / status / models / credits / claim / logout',
    input: { hint: 'login | status | models | credits | claim | logout' },
    handler: async (invocation) => {
      const sub = String(invocation?.rawInput ?? '').trim().split(/\s+/)[0] ?? ''
      try {
        if (sub === 'login' || sub === '') {
          const flow = await proto.startOAuthFlow({ fetcher: fetchImpl, logger })
          flow.result
            .then(async (credential) => {
              await store.write(credential)
              logger?.info?.(`officeace: 登录成功（${describeCredential(credential)}）`)
            })
            .catch((error) => logger?.warn?.(`officeace: 登录失败 ${String(error?.message ?? error)}`))
          openExternal(flow.loginUrl, logger)
          return {
            kind: 'success',
            text: [
              '果办OfficeAce：已打开浏览器完成华为云授权（若没弹出，请手动打开下面的链接）。',
              '登录完成后本机凭据会自动保存，之后直接选 officeace/* 的模型即可。',
              '',
              flow.loginUrl
            ].join('\n')
          }
        }
        if (sub === 'status') {
          const { credential } = await store.readFresh(logger, fetchImpl)
          if (credential === undefined) return { kind: 'success', text: '果办OfficeAce：尚未登录。用 /officeace login' }
          const models = await proto.fetchRemoteModels(credential, fetchImpl)
          const count = models.length > 0 ? models.length : proto.DEFAULT_MODELS.length
          return {
            kind: 'success',
            text: `${describeCredential(credential)}\n网关 ${credential.model_api_url_base ?? '(缺)'}\n可见模型 ${count} 个`
          }
        }
        if (sub === 'models') {
          const { credential } = await store.readFresh(logger, fetchImpl)
          if (credential === undefined) return { kind: 'error', text: '尚未登录，先说 /officeace login' }
          const models = await proto.fetchRemoteModels(credential, fetchImpl)
          const list = models.length > 0 ? models : proto.DEFAULT_MODELS.map((id) => ({ id }))
          return { kind: 'success', text: list.map((m) => `officeace/${m.id}`).join('\n') }
        }
        if (sub === 'credits') {
          const { credential } = await store.readFresh(logger, fetchImpl)
          if (credential === undefined) return { kind: 'error', text: '尚未登录，先说 /officeace login' }
          const sub2 = await proto.fetchSubscription(credential, fetchImpl)
          const balance = proto.mapBalance(sub2)
          const lines = balance.packages.map((p) => {
            const used = p.used === undefined ? '' : `（已用 ${fmtInt(p.used)}）`
            const exp = p.expiresAt ? ` · 到期 ${p.expiresAt}` : ''
            return `· ${p.name}：${fmtInt(p.total)}${used}${exp}`
          })
          return { kind: 'success', text: [`总积分 ${fmtInt(balance.total)}`, ...lines].join('\n') }
        }
        if (sub === 'claim') {
          const { credential } = await store.readFresh(logger, fetchImpl)
          if (credential === undefined) return { kind: 'error', text: '尚未登录，先说 /officeace login' }
          const skus = await proto.claimBonus(credential, fetchImpl)
          const points = proto.claimedPoints(skus)
          return points === null
            ? { kind: 'success', text: '今日无可领奖励。' }
            : { kind: 'success', text: `已领取 +${fmtInt(points)} 积分。` }
        }
        if (sub === 'logout') {
          await store.clear()
          return { kind: 'success', text: '已清除本机保存的果办OfficeAce 凭据。' }
        }
        return {
          kind: 'error',
          text: `未知子命令 "${sub}"。可用：login / status / models / credits / claim / logout`
        }
      } catch (error) {
        const message = String(error?.message ?? error)
        logger?.warn?.(`officeace: 命令失败 ${message}`)
        return { kind: 'error', text: `果办OfficeAce：${message}` }
      }
    }
  })
}

// ───────────────────────── 界面用的同源路由 ─────────────────────────

/** 读 JSON 请求体（上限 64KB，够用且不给自己挖坑） */
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
 * 挂不上（没有 webServer）也不影响渠道与命令 —— 只让卡片没数据。
 *
 * 路由（前缀 `/api/officeace`）：
 *   GET  /status    登录态 / 到期 / access_key
 *   POST /login     起 OAuth，返回 loginUrl（客户端负责打开）
 *   GET  /credits   积分明细
 *   POST /claim     领取每日奖励
 *   POST /logout    清凭据
 */
function registerRoutes(ctx, store, logger, fetchImpl) {
  // ⚠️ **必须用 `ctx.inject(['webServer'], …)`，不能在 apply 时 `ctx.get('webServer')` 取一次**：
  // 真实 web 组合里插件先于 browser 半身加载，那一刻 `webServer` 还没提供 —— 取到 undefined，
  // 路由就永远不注册，界面拿到的是 dsh 默认的 404（表现为卡片上「登录发起失败：not found」）。
  // `ctx.inject` 会等到该服务出现（或之后被替换）再跑回调。
  if (typeof ctx.inject !== 'function') {
    logger?.warn?.('officeace: ctx.inject 不可用，界面数据端点未挂载（/officeace 命令不受影响）')
    return
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/api\/officeace/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    try {
      if (method === 'GET' && route === '/status') {
        const { credential } = await store.readFresh(logger, fetchImpl)
        if (credential === undefined) return send(200, { loggedIn: false })
        const models = await proto.fetchRemoteModels(credential, fetchImpl)
        return send(200, {
          loggedIn: true,
          accessKey: credential.access_key_id ?? '',
          expiresAt: expiryMs(credential) ?? null,
          gateway: credential.model_api_url_base ?? '',
          modelCount: models.length > 0 ? models.length : proto.DEFAULT_MODELS.length,
          refreshable: isRefreshable(credential)
        })
      }
      if (method === 'POST' && route === '/login') {
        const flow = await proto.startOAuthFlow({ fetcher: fetchImpl, logger })
        flow.result
          .then(async (credential) => {
            await store.write(credential)
            logger?.info?.(`officeace: 登录成功（${describeCredential(credential)}）`)
          })
          .catch((error) => logger?.warn?.(`officeace: 登录失败 ${String(error?.message ?? error)}`))
        // 浏览器由宿主打开：桌面端比客户端的 window.open 可靠（客户端另有链接兜底）
        openExternal(flow.loginUrl, logger)
        return send(200, { loginUrl: flow.loginUrl })
      }
      if (method === 'GET' && route === '/credits') {
        const { credential } = await store.readFresh(logger, fetchImpl)
        if (credential === undefined) return send(409, { error: '尚未登录' })
        const sub = await proto.fetchSubscription(credential, fetchImpl)
        return send(200, proto.mapBalance(sub))
      }
      if (method === 'POST' && route === '/claim') {
        const { credential } = await store.readFresh(logger, fetchImpl)
        if (credential === undefined) return send(409, { error: '尚未登录' })
        const points = proto.claimedPoints(await proto.claimBonus(credential, fetchImpl))
        return points === null
          ? send(200, { kind: 'already', credit: 0, message: '今日无可领奖励' })
          : send(200, { kind: 'claimed', credit: points, message: `已领取 +${fmtInt(points)}` })
      }
      if (method === 'POST' && route === '/logout') {
        await store.clear()
        return send(200, { ok: true })
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
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/officeace', handler }),
      'officeace: api routes'
    )
    logger?.info?.('officeace: 界面数据端点已挂载 /api/officeace')
  })
}

// 供离线冒烟测试驱动（把 (req,res) 换成 mock 即可跑，不需要 dsh）
export { registerRoutes }

// ───────────────────────── 插件入口 ─────────────────────────

/**
 * @param ctx - cordis 上下文（`ctx.llm` 来自 dsh 内核；credentials/commands 为可选服务）
 * @param config - {@link Config} 解析后的配置
 */
export function apply(ctx, config) {
  const store = new CredentialStore(ctx, config.credentialRef)
  const fetchImpl = (...args) => fetch(...args)
  const logger = ctx.logger

  const adapter = new OfficeAceAdapter({ store, fetchImpl, logger, config })
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  logger?.info?.(`officeace: 渠道已注册（provider "${PROVIDER}"，凭据引用 ${config.credentialRef}）`)

  registerCommands(ctx, store, logger, fetchImpl, config)
  registerRoutes(ctx, store, logger, fetchImpl)

  // 定时续期：凭据是 ~2 小时的 STS 临时凭据，靠 refresh_token 续。
  // ⚠️ refresh_token 一次性，所以只在这一个定时器里续（对话路径只在 401 时补一次）。
  const timer = setInterval(() => {
    void (async () => {
      const credential = await store.read().catch(() => undefined)
      if (credential === undefined) return
      const exp = expiryMs(credential)
      if (exp === undefined || exp - Date.now() > REFRESH_LEAD_MS) return
      try {
        const next = await refreshCredential(credential, logger, fetchImpl)
        await store.write(next)
        logger?.info?.(`officeace: 定时续期完成，到期 ${next.expires_at}`)
      } catch (error) {
        logger?.warn?.(`officeace: 定时续期失败：${String(error?.message ?? error)}`)
      }
    })()
  }, RENEW_INTERVAL_MS)
  timer.unref?.()

  ctx.effect?.(() => () => {
    clearInterval(timer)
    registration()
  })
}
