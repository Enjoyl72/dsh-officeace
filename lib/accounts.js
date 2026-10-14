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

  /** 首个启用且有凭据的账号（模型目录/连通测试用） */
  async firstUsable() {
    for (const account of this.list()) {
      if (account.enabled !== true) continue
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
