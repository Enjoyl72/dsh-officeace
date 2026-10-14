/**
 * dsh-officeace —— 浏览器半身。
 *
 * 往 dsh 的「设置」里加一个 **settings.section**（id `officeace`）：果办OfficeAce 卡片 ——
 * 登录按钮 / 登录态与到期 / 积分明细 / 每日领取 / 退出。
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

    // ── 主题取色（都是 shell 提供的 CSS 变量）──
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      accent: 'var(--dsw-alias-state-business-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)'
    }

    async function call(path, options) {
      const { timeout = 20000, ...rest } = options ?? {}
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

    function when(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '未知'
      return new Date(ms).toLocaleString()
    }
    const fmt = value => Math.round(Number(value) || 0).toLocaleString()

    // ── 小组件 ──
    function pill(text, tone) {
      const color = tone === 'ok' ? C.ok : tone === 'bad' ? C.bad : C.sub
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 999, fontSize: 12,
          color, border: `1px solid ${C.border}`
        }
      }, text)
    }

    function button(label, onClick, opts) {
      const primary = opts?.primary === true
      const disabled = opts?.disabled === true
      return h('button', {
        onClick: disabled ? undefined : onClick,
        disabled,
        style: {
          padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${primary ? C.accent : C.border}`,
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : C.text,
          opacity: disabled ? 0.5 : 1
        }
      }, label)
    }

    function row(label, value, tone) {
      return h('div', {
        style: { display: 'flex', gap: 12, alignItems: 'baseline', padding: '3px 0', fontSize: 13 }
      },
        h('span', { style: { color: C.sub, minWidth: 72 } }, label),
        h('span', { style: { color: tone === 'bad' ? C.bad : C.text, wordBreak: 'break-all' } }, value))
    }

    // ── 卡片 ──
    function OfficeAceCard() {
      const [status, setStatus] = useState(undefined)
      const [credits, setCredits] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      /** 授权链接（浏览器没自动弹出时的兜底） */
      const [link, setLink] = useState('')
      const pollRef = useRef(null)

      const loadStatus = useCallback(async () => {
        try {
          const data = await get('/status')
          setStatus(data)
          return data
        } catch (error) {
          setStatus({ loggedIn: false, error: String(error?.message ?? error) })
          return undefined
        }
      }, [])

      const loadCredits = useCallback(async (silent) => {
        if (!silent) setBusy('credits')
        try {
          setCredits(await get('/credits', 60000))
        } catch (error) {
          setCredits({ error: String(error?.message ?? error) })
        } finally {
          if (!silent) setBusy('')
        }
      }, [])

      useEffect(() => {
        void loadStatus().then(data => {
          if (data?.loggedIn === true) void loadCredits(true)
        })
        return () => {
          if (pollRef.current !== null) clearInterval(pollRef.current)
        }
      }, [loadStatus, loadCredits])

      const login = async () => {
        setBusy('login')
        setNotice('正在启动本地回调…')
        let loginUrl = ''
        try {
          const result = await post('/login', {}, 60000)
          loginUrl = typeof result?.loginUrl === 'string' ? result.loginUrl : ''
          if (loginUrl.length === 0) {
            setNotice('未能取得授权链接')
            setBusy('')
            return
          }
        } catch (error) {
          setNotice(`登录发起失败：${String(error?.message ?? error)}`)
          setBusy('')
          return
        }
        // 浏览器由**宿主**打开（桌面端比 window.open 可靠）；这里再给一次链接兜底。
        setNotice('已打开浏览器完成华为云授权；若没弹出，请手动打开页面下方的链接。')
        setLink(loginUrl)
        // 轮询等回调完成（最多 ~3 分钟）
        let tries = 0
        if (pollRef.current !== null) clearInterval(pollRef.current)
        pollRef.current = setInterval(async () => {
          tries += 1
          const data = await loadStatus()
          if (data?.loggedIn === true) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setBusy('')
            setNotice('登录成功')
            setLink('')
            void loadCredits(true)
            return
          }
          if (tries >= 90) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setBusy('')
            setNotice('等待超时——可在浏览器里完成授权后点「刷新」')
          }
        }, 2000)
      }

      const claim = async () => {
        setBusy('claim')
        try {
          const result = await post('/claim', {}, 60000)
          setNotice(result.message ?? '已领取')
          void loadCredits(true)
        } catch (error) {
          setNotice(`领取失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        setBusy('logout')
        try {
          await post('/logout')
          setCredits(undefined)
          setNotice('已退出')
          setLink('')
          await loadStatus()
        } catch (error) {
          setNotice(`退出失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy('')
        }
      }

      const loggedIn = status?.loggedIn === true
      const packages = Array.isArray(credits?.packages) ? credits.packages : []

      return h('div', {
        style: {
          background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: 16, display: 'flex', flexDirection: 'column', gap: 10
        }
      },
        // 头：状态 + 动作
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', {
            style: {
              width: 8, height: 8, borderRadius: 999,
              background: loggedIn ? C.ok : C.faint
            }
          }),
          h('span', { style: { fontSize: 15, color: C.text } }, '果办OfficeAce'),
          h('span', { style: { fontSize: 12, color: C.faint } }, '华为云 AgentArts'),
          h('span', { style: { flex: 1 } }),
          pill(loggedIn ? '已登录' : '未登录', loggedIn ? 'ok' : undefined)),

        // 动作行
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          loggedIn
            ? null
            : button(busy === 'login' ? '等待授权…' : '登录', login, { primary: true, disabled: busy !== '' }),
          loggedIn ? button('刷新', async () => { await loadStatus(); await loadCredits(false) }, { disabled: busy !== '' }) : null,
          loggedIn ? button(busy === 'claim' ? '领取中…' : '领取每日奖励', claim, { disabled: busy !== '' }) : null,
          loggedIn ? button('退出', logout, { disabled: busy !== '' }) : null),

        // 状态细节
        loggedIn
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
            row('凭据', status?.accessKey ?? '', undefined),
            row('到期', when(status?.expiresAt), undefined),
            row('网关', status?.gateway ?? '—', undefined),
            row('模型', `${fmt(status?.modelCount ?? 0)} 个`, undefined))
          : h('div', { style: { fontSize: 13, color: C.sub } },
            '点「登录」后在浏览器完成华为云授权即可；不需要安装 OfficeAce 客户端。'),

        // 积分
        loggedIn
          ? h('div', {
            style: { borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }
          },
            h('div', { style: { fontSize: 13, color: C.text } },
              credits?.error !== undefined
                ? `积分读取失败：${credits.error}`
                : `总积分 ${fmt(credits?.total ?? 0)}`),
            ...packages.map((pkg, index) => h('div', {
              key: `${pkg.name ?? ''}-${index}`,
              style: { display: 'flex', gap: 12, fontSize: 12, color: C.sub }
            },
              h('span', { style: { flex: 1 } }, pkg.name ?? '—'),
              h('span', null),
              h('span', { style: { color: C.text } }, fmt(pkg.total)))))
          : null,

        notice.length > 0
          ? h('div', { style: { fontSize: 12, color: C.faint } }, notice)
          : null,

        // 授权链接兜底：浏览器没自动弹出时点这里
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
