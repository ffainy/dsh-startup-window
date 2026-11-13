/**
 * Browser half of dsh-startup-window.
 *
 * Hand-bundled: the module system serves lib/client.js verbatim, so this file is
 * already in the window.__ModuleLoader__.load({ id, factory }) form. It adds one
 * “settings.section” page with the startup width/height and talks to the Host
 * half through the Host's own RPC carrier (ctx.connection.rpc).
 */
window.__ModuleLoader__.load({
  id: 'dsh-startup-window',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    var PACKAGE = 'dsh-startup-window'
    var ENDPOINT = 'dsh-startup-window/apply'
    var STYLE_ID = 'dsh-startup-window-style'
    var ctxRef = null

    var CSS = [
      '.dws-root{display:flex;flex-direction:column;padding:4px 0 8px;}',
      '.dws-intro{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;line-height:20px;}',
      '.dws-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));}',
      '.dws-row:last-of-type{border-bottom:0;}',
      '.dws-copy{flex:1 1 auto;min-width:0;}',
      '.dws-title{color:var(--dsw-alias-label-primary,#111);font-size:14px;line-height:22px;}',
      '.dws-desc{margin-top:2px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px;}',
      '.dws-size{display:flex;align-items:center;gap:8px;flex:none;}',
      '.dws-input{width:92px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));background:transparent;color:var(--dsw-alias-label-primary,#111);font-size:14px;font-family:inherit;}',
      '.dws-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;}',
      '.dws-input:disabled{opacity:.5;}',
      '.dws-times{color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;}',
      '.dws-actions{display:flex;align-items:center;gap:10px;padding:14px 0 4px;}',
      '.dws-btn{padding:7px 14px;border-radius:8px;border:0;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-size:13px;font-family:inherit;cursor:pointer;}',
      '.dws-btn:hover{filter:brightness(1.06);}',
      '.dws-btn:disabled{opacity:.5;cursor:default;}',
      '.dws-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));}',
      '.dws-note{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.dws-note-error{color:#d9534f;}',
      '.dws-note-ok{color:#2e9e5b;}',
      '.dws-file{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all;}',
    ].join('')

    function injectStyle() {
      if (typeof document === 'undefined') return function () {}
      if (document.getElementById(STYLE_ID)) return function () {}
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
      return function () {
        try { el.remove() } catch (e) {}
      }
    }

    function rpcOf() {
      var ctx = ctxRef
      if (!ctx) return null
      var connection = null
      try { connection = ctx.connection || null } catch (e) { connection = null }
      if (!connection && typeof ctx.get === 'function') {
        try { connection = ctx.get('connection') || null } catch (e) { connection = null }
      }
      var rpc = connection && connection.rpc
      return rpc && typeof rpc.call === 'function' ? rpc : null
    }

    function host(method, payload) {
      var rpc = rpcOf()
      if (!rpc) {
        return Promise.resolve({ ok: false, error: { code: 'no-connection', message: '无法连接 Host（插件似乎没有在 Host 里加载）' } })
      }
      return rpc.call('/api', ENDPOINT, { method: method, payload: payload || {} }).then(
        function (result) {
          if (result && typeof result === 'object') return result
          return { ok: false, error: { code: 'empty-response', message: 'Host 返回为空' } }
        },
        function (error) {
          return { ok: false, error: { code: 'rpc-failed', message: String((error && error.message) || error) } }
        }
      )
    }

    function errorText(result) {
      if (!result) return '未知错误'
      if (result.error && result.error.message) return String(result.error.message)
      if (typeof result === 'string') return result
      try { return JSON.stringify(result).slice(0, 300) } catch (e) { return '未知错误' }
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dws-row' },
        h(
          'div',
          { className: 'dws-copy' },
          h('div', { className: 'dws-title' }, props.title),
          props.desc ? h('div', { className: 'dws-desc' }, props.desc) : null
        ),
        props.children
      )
    }

    function SettingsSection() {
      var loadingPair = React.useState(true)
      var loading = loadingPair[0]
      var setLoading = loadingPair[1]
      var widthPair = React.useState(1280)
      var width = widthPair[0]
      var setWidth = widthPair[1]
      var heightPair = React.useState(820)
      var height = heightPair[0]
      var setHeight = heightPair[1]
      var enabledPair = React.useState(true)
      var enabled = enabledPair[0]
      var setEnabled = enabledPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var notePair = React.useState('')
      var note = notePair[0]
      var setNote = notePair[1]
      var tonePair = React.useState('muted')
      var tone = tonePair[0]
      var setTone = tonePair[1]
      var filePair = React.useState('')
      var file = filePair[0]
      var setFile = filePair[1]

      React.useEffect(function () {
        var alive = true
        host('load').then(function (result) {
          if (!alive) return
          setLoading(false)
          if (result && result.ok && result.value && result.value.config) {
            var config = result.value.config
            setWidth(config.width)
            setHeight(config.height)
            setEnabled(config.enabled !== false)
            setFile(result.value.file || '')
          } else {
            setTone('error')
            setNote('读取设置失败：' + errorText(result))
          }
        })
        return function () { alive = false }
      }, [])

      var submit = React.useCallback(
        function () {
          var w = Math.round(Number(width))
          var hh = Math.round(Number(height))
          if (!Number.isFinite(w) || !Number.isFinite(hh) || w < 520 || hh < 600) {
            setTone('error')
            setNote('尺寸不合法：宽至少 520，高至少 600。')
            return
          }
          var config = { width: w, height: hh, enabled: enabled !== false }
          setBusy(true)
          setTone('muted')
          setNote('正在保存并调整窗口…')
          host('save', { config: config })
            .then(function (saved) {
              if (!saved || !saved.ok) throw new Error('保存设置失败：' + errorText(saved))
              return host('apply', { config: config })
            })
            .then(function (result) {
              setBusy(false)
              var applied = result && result.ok && result.value ? result.value.result : result
              if (applied && applied.ok) {
                setTone('ok')
                setNote('已调整到 ' + w + ' × ' + hh + '。' + (applied.tail ? '\n' + applied.tail : ''))
              } else {
                setTone('error')
                setNote('调整失败：' + errorText(applied))
              }
            })
            .catch(function (error) {
              setBusy(false)
              setTone('error')
              setNote(String((error && error.message) || error))
            })
        },
        [width, height, enabled]
      )

      var refresh = React.useCallback(function () {
        setBusy(true)
        setTone('muted')
        host('status').then(function (result) {
          setBusy(false)
          if (result && result.ok && result.value) {
            setTone('muted')
            setNote('最近一次记录：' + (result.value.tail || '(空)'))
          } else {
            setTone('error')
            setNote('读取日志失败：' + errorText(result))
          }
        })
      }, [])

      var disabled = busy || loading

      return h(
        'div',
        { className: 'dws-root' },
        h(
          'p',
          { className: 'dws-intro' },
          'DSH 桌面版每次启动都按写死的 1280 × 820 建窗口，也不保存窗口大小。这里设定启动尺寸：保存后立即应用一次，之后每次启动 DSH 自动应用。窗口会以当前显示器的工作区居中摆放，尺寸超过屏幕时自动收进屏幕内。'
        ),
        h(
          Row,
          { title: '启动窗口尺寸', desc: '宽 × 高，单位是 Electron 的逻辑像素（DIP），最小 520 × 600。' },
          h(
            'div',
            { className: 'dws-size' },
            h('input', {
              className: 'dws-input',
              type: 'number',
              min: 520,
              max: 7680,
              step: 10,
              value: width,
              disabled: disabled,
              onChange: function (event) { setWidth(event.target.value) },
            }),
            h('span', { className: 'dws-times' }, '×'),
            h('input', {
              className: 'dws-input',
              type: 'number',
              min: 600,
              max: 7680,
              step: 10,
              value: height,
              disabled: disabled,
              onChange: function (event) { setHeight(event.target.value) },
            })
          )
        ),
        h(
          Row,
          { title: '启动时自动应用', desc: '关掉后只保存数值，不再自动调整窗口。' },
          h('input', {
            type: 'checkbox',
            checked: enabled !== false,
            disabled: disabled,
            onChange: function (event) { setEnabled(event.target.checked) },
          })
        ),
        h(
          'div',
          { className: 'dws-actions' },
          h(
            'button',
            { className: 'dws-btn', type: 'button', disabled: disabled, onClick: submit },
            busy ? '处理中…' : '保存并应用'
          ),
          h(
            'button',
            { className: 'dws-btn dws-btn-ghost', type: 'button', disabled: disabled, onClick: refresh },
            '查看最近一次结果'
          )
        ),
        note ? h('div', { className: 'dws-note dws-note-' + tone }, note) : null,
        file ? h('div', { className: 'dws-file' }, '设置文件：' + file) : null
      )
    }

    function apply(ctx) {
      ctxRef = ctx
      var disposeStyle = injectStyle()
      var disposers = []
      try {
        disposers.push(
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'startup-window',
                order: 95,
                label: function () { return '窗口大小' },
                inject: function () { return {} },
              },
              SettingsSection
            )
          })
        )
      } catch (error) {
        console.error('[' + PACKAGE + '] cannot register the settings page', error)
      }
      var dispose = function () {
        for (var i = 0; i < disposers.length; i++) {
          try {
            var item = disposers[i]
            var maybe = typeof item === 'function' ? item() : null
            if (typeof maybe === 'function') maybe()
          } catch (error) { }
        }
        disposeStyle()
      }
      try {
        if (typeof ctx.effect === 'function') ctx.effect(function () { return dispose }, PACKAGE + ': dispose')
      } catch (error) { }
      return dispose
    }

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
