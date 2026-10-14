/**
 * 果办OfficeAce 的账号池与渠道级模型黑名单（落盘 JSON）。
 *
 * 文件：`~/.dsh/officeace/state.json`
 *   { "accounts": [ { id, ref, nickname, enabled, createdAt } ], "disabledModels": [ ... ] }
 *
 * 凭据本体不在这里 —— 每个账号一份，存 dsh 的凭据服务（`ctx.credentials`），
 * ref 形如 `OFFICEACE_ACCOUNT_1`（必须是 POSIX shell 标识符）。
 *
 * ⚠️ 兼容既有单账号：早先版本用的是 `OFFICEACE_ACCESS_KEY_ID`。首次加载时若它已存在
 * 而这里还没有账号，就直接把它收编为 1 号账号 —— 不逼用户重新登录。
 *
 * @module dsh-officeace/accounts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 早先单账号版本用的引用名（收编为 1 号账号） */
export const LEGACY_CRED_REF = 'OFFICEACE_ACCESS_KEY_ID'

const STATE_DIR = join(homedir(), '.dsh', 'officeace')
const STATE_FILE = join(STATE_DIR, 'state.json')

export class AccountStore {
  constructor(ctx, logger) {
    this.ctx = ctx
    this.logger = logger
    this.state = undefined
    /**
     * 账号 → 手里**最快到期**的那个积分包的到期时刻（见 noteCredits）。
     * 纯派生快照，**不落盘**（重启后为空 = 排序退回数组顺序，不影响正确性）。
     */
    this.creditHints = new Map()
  }

  /**
   * 记一份积分快照（由 `/credits` 顺带更新），用于把**手里压着快过期积分**的账号排到前面先用掉，
   * 免得那些包白白过期。
   *
   * ⚠️ 只是**排序提示**，不决定谁能用；没有快照的账号退回数组顺序。
   * 之所以不现查：每挑一次号就打一轮额度接口，风控不说，光延迟就受不了。
   */
  noteCredits(rows) {
    this.creditHints = new Map()
    for (const row of rows ?? []) {
      if (row?.ok !== true) continue
      let soonest = Number.POSITIVE_INFINITY
      for (const pack of row.packages ?? []) {
        if (!(Number(pack?.remaining ?? pack?.total) > 0)) continue
        const at = Date.parse(pack?.expiresAt ?? '')
        if (Number.isFinite(at)) soonest = Math.min(soonest, at)
      }
      this.creditHints.set(row.id, soonest)
    }
  }

  /** 该账号最快到期的积分时刻；无数据 / 无到期 → `Infinity`（排序时自然排最后） */
  creditHintFor(id) {
    const at = this.creditHints.get(id)
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
  }

  get credentials() {
    return this.ctx.get('credentials')
  }

  /** 归属到某个账号的凭据引用名 */
  static refFor(index) {
    return `OFFICEACE_ACCOUNT_${index}`
  }

  load() {
    if (this.state !== undefined) return this.state
    let parsed = undefined
    try {
      parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {
      parsed = undefined
    }
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.filter((a) => typeof a?.id === 'string' && typeof a?.ref === 'string') : []
    this.state = {
      accounts,
      disabledModels: Array.isArray(parsed?.disabledModels) ? parsed.disabledModels.filter((m) => typeof m === 'string') : [],
      ...(parsed?.login !== undefined && parsed.login !== null ? { login: parsed.login } : {})
    }
    return this.state
  }

  flush() {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (error) {
      this.logger?.warn?.(`officeace: 写账号池失败 ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 首次加载时把早先的单账号收编进来（幂等）。
   * 只读凭据服务、不写它，因此对未登录用户是空操作。
   */
  async adoptLegacy() {
    const state = this.load()
    if (state.accounts.length > 0) return
    const service = this.credentials
    if (service === undefined) return
    let hit
    try {
      hit = await service.resolve(LEGACY_CRED_REF)
    } catch {
      return
    }
    if (hit === undefined) return
    state.accounts.push({ id: 'oa-1', ref: LEGACY_CRED_REF, nickname: '', enabled: true, createdAt: Date.now() })
    this.nextIndex = 2
    this.flush()
    this.logger?.info?.('officeace: 已把早先的单账号收编为 1 号账号')
  }

  /** 下一个可用的账号序号：**ref 与 id 都要查重**（收编的旧账号 id 也叫 oa-1） */
  nextRef() {
    const state = this.load()
    const usedRefs = new Set(state.accounts.map((a) => a.ref))
    const usedIds = new Set(state.accounts.map((a) => a.id))
    let index = 1
    while (usedRefs.has(AccountStore.refFor(index)) || usedIds.has(`oa-${index}`)) index += 1
    return { index, ref: AccountStore.refFor(index), id: `oa-${index}` }
  }

  list() {
    return this.load().accounts
  }

  get(id) {
    return this.list().find((a) => a.id === id)
  }

  /** 新增一个账号（凭据由调用方写入） */
  add({ id, ref, nickname }) {
    const state = this.load()
    state.accounts.push({ id, ref, nickname: nickname ?? '', enabled: true, createdAt: Date.now() })
    this.flush()
    return state.accounts[state.accounts.length - 1]
  }

  setEnabled(id, enabled) {
    const account = this.get(id)
    if (account === undefined) return false
    account.enabled = enabled === true
    this.flush()
    return true
  }

  /**
   * 重排账号顺序 —— **数组顺序就是对话时的候选优先级**（第一个可用的先用）。
   *
   * `ids` 必须是现有账号的一个**完整排列**：既不能漏、也不能多、更不能有重复。
   * 校验不过就原样返回 false（宁可不动，也不要把账号池弄成缺项或重复项）。
   */
  reorder(ids) {
    const state = this.load()
    if (!Array.isArray(ids) || ids.length !== state.accounts.length) return false
    const byId = new Map(state.accounts.map((a) => [a.id, a]))
    const seen = new Set()
    const next = []
    for (const id of ids) {
      const account = byId.get(id)
      if (account === undefined || seen.has(id)) return false
      seen.add(id)
      next.push(account)
    }
    if (next.length !== state.accounts.length) return false
    state.accounts = next
    this.flush()
    return true
  }

  setNickname(id, nickname) {
    const account = this.get(id)
    if (account === undefined) return false
    account.nickname = String(nickname ?? '')
    this.flush()
    return true
  }

  async remove(id) {
    const state = this.load()
    const index = state.accounts.findIndex((a) => a.id === id)
    if (index < 0) return false
    const [account] = state.accounts.splice(index, 1)
    const service = this.credentials
    if (service !== undefined) {
      try {
        if (typeof service.unset === 'function') await service.unset(account.ref)
        else if (typeof service.delete === 'function') await service.delete(account.ref)
      } catch (error) {
        this.logger?.warn?.(`officeace: 清除账号 ${id} 的凭据失败 ${String(error?.message ?? error)}`)
      }
    }
    this.flush()
    return true
  }

  async readCredential(account) {
    const service = this.credentials
    if (service === undefined) return undefined
    try {
      const hit = await service.resolve(account.ref)
      if (hit === undefined) return undefined
      const parsed = JSON.parse(hit.value)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async writeCredential(account, credential) {
    const service = this.credentials
    if (service === undefined) throw new Error('dsh 的凭据服务不可用，无法保存登录态')
    await service.set(account.ref, JSON.stringify(credential))
  }

  /**
   * 首个**有凭据**的账号（模型目录 / 「是否已登录」门控用）。
   *
   * ⚠️ **故意不看 `enabled`** —— 停用只是「别拿它跑对话」，不代表这个渠道没登录、
   * 也不代表模型清单该藏着。真正发请求时的启停过滤在适配器 `stream()` 里另有一道。
   * 「有凭据」和「能拿来发请求」是两件事，改之前先想清楚。
   */
  async firstWithCredential() {
    for (const account of this.list()) {
      const credential = await this.readCredential(account)
      if (credential !== undefined) return { account, credential }
    }
    return undefined
  }

  // ── 按模型限流记账（对齐原插件的 modelRateLimits 语义） ──

  /**
   * 记录某账号对某模型的限流解禁时刻（只接受更晚的时间 —— 与插件一致，
   * 否则后到的"重试成功"会把更晚的解禁时间冲掉）。
   */
  recordRateLimit(id, model, resetAt) {
    const account = this.get(id)
    if (account === undefined || typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) return
    account.rateLimits = account.rateLimits ?? {}
    const current = account.rateLimits[model] ?? 0
    if (resetAt <= current) return
    account.rateLimits[model] = resetAt
    this.flush()
  }

  /** 某账号对某模型是否仍在限流中 */
  isLimited(id, model, now = Date.now()) {
    const account = this.get(id)
    const resetAt = account?.rateLimits?.[model] ?? 0
    return resetAt > now
  }

  /** 该账号所有模型中最早/最晚的解禁时刻（界面显示用；0 = 未限流） */
  limitedUntil(id, now = Date.now()) {
    const account = this.get(id)
    const limits = Object.values(account?.rateLimits ?? {}).filter((at) => typeof at === 'number' && at > now)
    return limits.length === 0 ? 0 : Math.max(...limits)
  }

  // ── 登录会话状态（界面显示失败原因；落盘以便重启后仍看得见） ──

  setLogin(patch) {
    const state = this.load()
    state.login = { ...(state.login ?? {}), ...patch }
    this.flush()
    return state.login
  }

  login() {
    return this.load().login
  }

  // ── 渠道级模型黑名单 ──

  disabledModels() {
    return this.load().disabledModels
  }

  setModelDisabled(model, disabled) {
    const state = this.load()
    const set = new Set(state.disabledModels)
    if (disabled === true) set.add(model)
    else set.delete(model)
    state.disabledModels = [...set]
    this.flush()
    return state.disabledModels
  }

  setAllModelsDisabled(models, disabled) {
    const state = this.load()
    if (disabled === true) {
      const set = new Set([...state.disabledModels, ...models])
      state.disabledModels = [...set]
    } else {
      const drop = new Set(models)
      state.disabledModels = state.disabledModels.filter((m) => !drop.has(m))
    }
    this.flush()
    return state.disabledModels
  }
}
