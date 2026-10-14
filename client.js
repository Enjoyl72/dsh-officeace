/**
 * dsh-officeace —— 浏览器半身。
 *
 * 往 dsh 的「设置」里加一个 **settings.section**（id `officeace`）：果办OfficeAce 卡片 ——
 * 账号列表（启用/到期 + 测试/续期/停用/移除）、模型开关区（已开启 x/y + 逐模型开关）、
 * 积分明细与每日领取、以及「＋添加账号」（浏览器完成华为云授权）。
 *
 * 数据走**本插件自己的同源路由** `/api/officeace/*`（宿主半身用 `server.register` 挂的），
 * 不用 typed Remote：那些路由在任何内核线上都由同一个宿主进程提供。
 *
 * 手写 ModuleLoader bundle：**无构建步骤**，除 shell 已提供的 `react` 外无依赖。
 * 配色一律取主题变量 `--dsw-alias-*`，因此深/浅色切换都能跟。
 */
window.__ModuleLoader__.load({
  id: 'dsh-officeace',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const inject = ['slots']
    // 与上游同款：按 document.baseURI 解析，dsh 若挂在子路径下也能命中（不要写死 '/api/...'）
    const API = (() => {
      try {
        return new URL('api/officeace', document.baseURI).pathname
      } catch {
        return '/api/officeace'
      }
    })()

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-state-business-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)'
    }

    async function call(path, options) {
      const { timeout = 30000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, {
          ...rest,
          redirect: 'error',
          signal: controller.signal,
          ...(rest.body === undefined ? {} : { headers: { 'content-type': 'application/json' } })
        })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 200) }
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }
    const get = (path, timeout) => call(path, { method: 'GET', timeout })
    const post = (path, body, timeout) => call(path, { method: 'POST', body: JSON.stringify(body ?? {}), timeout })

    const fmt = value => Math.round(Number(value) || 0).toLocaleString()
    const when = ms => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '未知')
    /**
     * 账号显示名：昵称优先，否则用 Access Key。**整串显示、不截断** ——
     * 截成 `…9T8E5150` 时两个账号看着一样，认不出哪个是哪个。
     */
    const accountName = account => {
      const nickname = typeof account?.nickname === 'string' ? account.nickname.trim() : ''
      if (nickname.length > 0) return nickname
      const key = account?.accessKey
      if (typeof key === 'string' && key.length > 0) return key
      return account?.id ?? '—'
    }

    // ── 小组件 ──
    function chip(label, onClick, opts) {
      const primary = opts?.primary === true
      const danger = opts?.danger === true
      const disabled = opts?.disabled === true
      const color = disabled ? C.faint : danger ? C.bad : primary ? '#fff' : C.text
      return h('button', {
        key: opts?.key,
        onClick: disabled ? undefined : onClick,
        disabled,
        title: opts?.title,
        style: {
          padding: '4px 10px', borderRadius: 8, fontSize: 12, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${primary ? C.accent : C.border}`,
          background: primary ? C.accent : C.bg2,
          color
        }
      }, label)
    }

    function badge(label, tone) {
      const color = tone === 'ok' ? C.ok : tone === 'bad' ? C.bad : C.sub
      return h('span', {
        style: { padding: '1px 7px', borderRadius: 999, fontSize: 11, color, border: `1px solid ${C.border}` }
      }, label)
    }

    function sectionTitle(text, right) {
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }
      },
        h('span', { style: { fontSize: 13, color: C.text } }, text),
        h('span', { style: { flex: 1 } }),
        right ?? null)
    }

    // ── 账号行 ──
    function AccountRow(props) {
      const { account, credit, busy, index, count, onTest, onRefresh, onToggle, onRemove, onRename, onMove } = props
      const [testText, setTestText] = useState('')
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [showBreakdown, setShowBreakdown] = useState(false)
      /** 该账号的积分组成：点账号名或积分数时展开，平时不占地方 */
      const packages = credit?.ok === true && Array.isArray(credit.packages) ? credit.packages : []
      const expandable = packages.length > 0

      /** 提交改名：留空 = 清掉昵称，回到用 Access Key 显示 */
      const commitRename = () => {
        setEditing(false)
        void onRename(account, draft.trim())
      }
      return h('div', {
        style: { padding: '8px 0', borderTop: `1px solid ${C.border}` }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          editing
            ? h('input', {
              autoFocus: true,
              value: draft,
              placeholder: '起个名（留空＝仍用 Access Key）',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commitRename()
                else if (event.key === 'Escape') setEditing(false)
              },
              style: {
                flex: 1, minWidth: 150, fontSize: 13, padding: '3px 8px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: C.bg2, color: C.text, outline: 'none'
              }
            })
            : h('span', {
              onClick: expandable ? () => setShowBreakdown((open) => !open) : undefined,
              title: expandable ? '点击看这个账号的积分组成' : undefined,
              style: { fontSize: 13, color: C.text, wordBreak: 'break-all', cursor: expandable ? 'pointer' : 'default' }
            }, accountName(account)),
          badge(account.enabled ? '启用' : '已停用', account.enabled ? 'ok' : undefined),
          // 本账号的积分就摆在「启用」后面 —— 比在卡片底部再列一遍更好认
          credit?.ok === true
            ? h('span', {
              onClick: expandable ? () => setShowBreakdown((open) => !open) : undefined,
              title: expandable ? '点击看这个账号的积分组成' : undefined,
              style: { fontSize: 12, color: C.ok, cursor: expandable ? 'pointer' : 'default' }
            }, `${fmt(credit.total)} 积分${expandable ? (showBreakdown ? ' ▾' : ' ▸') : ''}`)
            : null,
          account.limitedUntil > 0 ? badge(`限流至 ${when(account.limitedUntil)}`, 'bad') : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, color: C.faint } },
            account.expiresAt === null ? '到期未知' : `到期 ${when(account.expiresAt)}`)),
        // 展开的积分组成：紧跟被点的那一行，不点就一直不占地方
        showBreakdown && expandable
          ? h('div', { style: { fontSize: 11, color: C.faint, marginTop: 4, wordBreak: 'break-all' } },
            // 用 remaining（剩余）而不是 total（额度），这样各包加起来 = 账号那行显示的积分
            `剩余：${packages.map((p) => `${p.name} ${fmt(p.remaining ?? p.total)}`).join(' · ')}`)
          : null,
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' } },
          ...(editing
            ? [chip('确定', commitRename, { primary: true, key: 'ok' }),
              chip('取消', () => setEditing(false), { key: 'cancel' })]
            : [
              // 顺序就是对话时的候选优先级，所以箭头放在最前面
              chip('↑', () => onMove(account, -1), { key: 'up', title: '上移（越靠前越优先被使用）', disabled: busy !== '' || index === 0 }),
              chip('↓', () => onMove(account, 1), { key: 'down', title: '下移（越靠后越晚被使用）', disabled: busy !== '' || index >= count - 1 }),
              chip('测试', async () => {
                setTestText('测试中…')
                try {
                  const result = await get(`/accounts/${encodeURIComponent(account.id)}/test`, 60000)
                  setTestText(result.ok === true ? `连接正常（${result.models} 个模型 · ${result.ms}ms）` : `测试失败：${result.error ?? '未知'}`)
                } catch (error) {
                  setTestText(`测试失败：${String(error?.message ?? error)}`)
                }
              }, { key: 'test', disabled: busy !== '' }),
              chip(busy === `refresh-${account.id}` ? '续期中…' : '续期', () => onRefresh(account), { key: 'refresh', disabled: busy !== '' }),
              chip(account.enabled ? '停用' : '启用', () => onToggle(account), { key: 'toggle', disabled: busy !== '' }),
              chip('改名', () => {
                setDraft(account.nickname ?? '')
                setEditing(true)
              }, { key: 'rename', disabled: busy !== '' }),
              chip('移除', () => onRemove(account), { key: 'remove', disabled: busy !== '', danger: true }),
              testText.length > 0
                ? h('span', {
                  key: 'testText',
                  style: { fontSize: 11, color: testText.startsWith('测试失败') || testText.startsWith('连接失败') ? C.bad : C.faint, wordBreak: 'break-all' }
                }, testText)
                : null
            ])),
        account.modelInfoError.length > 0
          ? h('div', { style: { fontSize: 11, color: C.bad, marginTop: 4, wordBreak: 'break-all' } },
            `上次取网关密钥失败：${account.modelInfoError}（点「续期」重试）`)
          : null)
    }

    // ── 模型行 ──
    function ModelRow(props) {
      const { model, busy, onToggle } = props
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
          borderTop: `1px solid ${C.border}`
        }
      },
        h('span', {
          style: { flex: 1, fontSize: 13, color: model.disabled ? C.faint : C.text, wordBreak: 'break-all' }
        }, model.id),
        chip(model.disabled ? '关' : '开', () => onToggle(model), {
          disabled: busy !== '',
          primary: !model.disabled
        }))
    }

    // ── 卡片 ──
    function OfficeAceCard() {
      const [data, setData] = useState(undefined)
      const [credits, setCredits] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [link, setLink] = useState('')
      const [open, setOpen] = useState('accounts')
      const pollRef = useRef(null)

      const load = useCallback(async (silent) => {
        if (!silent) setBusy('load')
        try {
          setData(await get('/status'))
        } catch (error) {
          setNotice(`读取失败：${String(error?.message ?? error)}`)
        } finally {
          if (!silent) setBusy('')
        }
      }, [])

      const loadCredits = useCallback(async () => {
        try {
          setCredits(await get('/credits', 60000))
        } catch (error) {
          setCredits({ accounts: [], total: 0, error: String(error?.message ?? error) })
        }
      }, [])

      useEffect(() => {
        void load().then(() => void loadCredits())
        return () => {
          if (pollRef.current !== null) clearInterval(pollRef.current)
        }
      }, [load, loadCredits])

      const withBusy = async (tag, action) => {
        setBusy(tag)
        try {
          await action()
        } catch (error) {
          setNotice(String(error?.message ?? error))
        } finally {
          setBusy('')
        }
      }

      const addAccount = async () => {
        setBusy('login')
        setNotice('正在启动本地回调…')
        try {
          const result = await post('/login', {}, 60000)
          if (typeof result?.loginUrl !== 'string' || result.loginUrl.length === 0) {
            setNotice('未能取得授权链接')
            setBusy('')
            return
          }
          setLink(result.loginUrl)
          setNotice('已打开浏览器完成华为云授权；若没弹出，请手动打开下面的链接。')
        } catch (error) {
          setNotice(`登录发起失败：${String(error?.message ?? error)}`)
          setBusy('')
          return
        }
        const before = data?.accounts?.length ?? 0
        let tries = 0
        if (pollRef.current !== null) clearInterval(pollRef.current)
        pollRef.current = setInterval(async () => {
          tries += 1
          try {
            const next = await get('/status')
            setData(next)
            if ((next?.accounts?.length ?? 0) > before) {
              clearInterval(pollRef.current)
              pollRef.current = null
              setBusy('')
              setNotice('登录成功')
              setLink('')
              void loadCredits()
              return
            }
            // 宿主已经把失败原因写进账号池：不用再等满 3 分钟
            if (next?.login?.status === 'failed') {
              clearInterval(pollRef.current)
              pollRef.current = null
              setBusy('')
              setNotice('')
            }
          } catch {
            /* 轮询失败继续等 */
          }
          if (tries >= 90) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setBusy('')
            setNotice('等待超时——可在浏览器完成授权后点「刷新」')
          }
        }, 2000)
      }

      const accounts = data?.accounts ?? []
      const models = data?.models?.items ?? []
      const enabledAccounts = accounts.filter((a) => a.enabled).length
      const enabledModels = models.filter((m) => !m.disabled).length

      return h('div', {
        style: {
          background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: 16, display: 'flex', flexDirection: 'column', gap: 8
        }
      },
        // 卡头
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 999, background: enabledAccounts > 0 ? C.ok : C.faint } }),
          h('span', { style: { fontSize: 15, color: C.text } }, '果办OfficeAce'),
          h('span', { style: { fontSize: 12, color: C.faint } }, '华为云 AgentArts'),
          h('span', { style: { flex: 1 } }),
          credits === undefined
            ? null
            : credits.error !== undefined
              ? h('span', { style: { fontSize: 12, color: C.bad } }, '积分读取失败')
              : h('span', { style: { fontSize: 12, color: C.ok } }, `总积分 ${fmt(credits.total ?? 0)}`),
          h('span', { style: { fontSize: 12, color: C.sub } },
            `账号 ${enabledAccounts}/${accounts.length}　模型 ${enabledModels}/${models.length}`)),

        // 动作行
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          chip(busy === 'login' ? '等待授权…' : '＋ 添加账号', addAccount, { primary: true, disabled: busy !== '' }),
          chip('续期', () => withBusy('refreshAll', async () => {
            for (const account of accounts) {
              await post(`/accounts/${encodeURIComponent(account.id)}/refresh`, {}, 60000)
            }
            setNotice('续期完成')
            await load(true)
          }), { disabled: busy !== '' || accounts.length === 0 }),
          chip('⟳ 积分', () => withBusy('credits', loadCredits), { disabled: busy !== '' || accounts.length === 0 }),
          chip('🎁 领取', () => withBusy('claim', async () => {
            const result = await post('/claim', {}, 60000)
            const rows = Array.isArray(result.accounts) ? result.accounts : []
            const already = rows.filter((r) => r.kind === 'already').length
            const failed = rows.filter((r) => r.kind === 'failed').length
            setNotice(`领取完成：共 +${fmt(result.claimed ?? 0)}${already > 0 ? `，已领 ${already}` : ''}${failed > 0 ? `，失败 ${failed}` : ''}`)
            await loadCredits()
          }), { disabled: busy !== '' || accounts.length === 0 }),
          chip('刷新', () => withBusy('load', async () => { await load(true); await loadCredits() }), { disabled: busy !== '' }),
          // 两个折叠开关从原来单独占的那一行，挪到「＋ 添加账号」这一行的右边
          h('span', { style: { flex: 1 } }),
          h('span', {
            onClick: () => setOpen(open === 'accounts' ? '' : 'accounts'),
            style: { fontSize: 12, cursor: 'pointer', alignSelf: 'center', color: open === 'accounts' ? C.text : C.faint }
          }, `${open === 'accounts' ? '▾' : '▸'} 账号 (${accounts.length})`),
          h('span', {
            onClick: () => setOpen(open === 'models' ? '' : 'models'),
            style: { fontSize: 12, cursor: 'pointer', alignSelf: 'center', color: open === 'models' ? C.text : C.faint }
          }, `${open === 'models' ? '▾' : '▸'} 模型 (${enabledModels}/${models.length})`)),

        // 账号区
        open === 'accounts'
          ? accounts.length === 0
            ? h('div', { style: { fontSize: 13, color: C.sub, paddingTop: 6 } },
              '还没有账号——点「＋ 添加账号」在浏览器完成华为云授权。不需要安装 OfficeAce 客户端。')
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              ...accounts.map((account, index) => h(AccountRow, {
                key: account.id,
                account,
                index,
                count: accounts.length,
                credit: (credits?.accounts ?? []).find((row) => row.id === account.id),
                busy,
                onTest: undefined,
                onRefresh: (row) => withBusy(`refresh-${row.id}`, async () => {
                  await post(`/accounts/${encodeURIComponent(row.id)}/refresh`, {}, 60000)
                  setNotice(`${accountName(row)} 已续期`)
                  await load(true)
                }),
                onToggle: (row) => withBusy(`toggle-${row.id}`, async () => {
                  await post(`/accounts/${encodeURIComponent(row.id)}/enable`, { enabled: !row.enabled })
                  await load(true)
                }),
                // 该路由回的是完整状态，直接 setData —— 账号名一改，积分区那列的显示也跟着变
                onRename: (row, nickname) => withBusy(`rename-${row.id}`, async () => {
                  setData(await post(`/accounts/${encodeURIComponent(row.id)}/nickname`, { nickname }))
                  setNotice(nickname.length > 0 ? `已改名为「${nickname}」` : '已恢复用 Access Key 显示')
                }),
                // 宿主收的是「完整排列」，所以在这里把新顺序算好整份发过去
                onMove: (row, delta) => withBusy(`move-${row.id}`, async () => {
                  const ids = accounts.map((item) => item.id)
                  const from = ids.indexOf(row.id)
                  const to = from + delta
                  if (from < 0 || to < 0 || to >= ids.length) return
                  const [moved] = ids.splice(from, 1)
                  ids.splice(to, 0, moved)
                  setData(await post('/accounts/reorder', { ids }))
                  setNotice(`已调整顺序：${accountName(row)} 现在排第 ${to + 1} 位`)
                }),
                onRemove: (row) => withBusy(`remove-${row.id}`, async () => {
                  await post(`/accounts/${encodeURIComponent(row.id)}/remove`)
                  setNotice(`已移除 ${accountName(row)}`)
                  await load(true)
                  await loadCredits()
                })
              })))
          : null,

        // 模型区
        open === 'models'
          ? models.length === 0
            ? h('div', { style: { fontSize: 13, color: C.sub, paddingTop: 6 } }, '还没有模型——先添加账号登录。')
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                chip('全部开启', () => withBusy('models', async () => {
                  setData(await post('/models/disableAll', { disabled: false }))
                }), { disabled: busy !== '' }),
                chip('全部关闭', () => withBusy('models', async () => {
                  setData(await post('/models/disableAll', { disabled: true }))
                }), { disabled: busy !== '' })),
              ...models.map((model) => h(ModelRow, {
                key: model.id,
                model,
                busy,
                onToggle: (row) => withBusy(`model-${row.id}`, async () => {
                  setData(await post('/models/disable', { model: row.id, disabled: !row.disabled }))
                })
              })))
          : null,

        // 登录会话（宿主写进账号池）：失败原因直接摆出来，不用去翻日志
        data?.login?.status === 'failed'
          ? h('div', { style: { fontSize: 12, color: C.bad, wordBreak: 'break-all' } },
            `上次登录未完成：${data.login.error ?? '未知原因'}`)
          : null,

        notice.length > 0 ? h('div', { style: { fontSize: 12, color: C.faint } }, notice) : null,
        link.length > 0
          ? h('a', {
            href: link,
            target: '_blank',
            rel: 'noopener',
            style: { fontSize: 12, color: C.accent, wordBreak: 'break-all' }
          }, link)
          : null)
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'officeace',
        order: 36,
        label: () => '果办OfficeAce'
      }, OfficeAceCard))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'officeace'
    return module.exports
  }
})
