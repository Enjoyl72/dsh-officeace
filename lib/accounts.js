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
      disabledModels: Array.isArray(parsed?.disabledModels) ? parsed.disabledModels.filter((m) => typeof m === 'string') : []
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

  /** 下一个可用的账号序号（避免 ref 撞车） */
  nextRef() {
    const state = this.load()
    let index = 1
    const used = new Set(state.accounts.map((a) => a.ref))
    while (used.has(AccountStore.refFor(index))) index += 1
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
