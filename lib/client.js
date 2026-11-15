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
    var MIN_W = 520
    var MIN_H = 600
    var MAX_SIDE = 7680
    var LOCALE_NS = 'startupWindow'
    var ctxRef = null

    var ZH = {
      nav: '窗口大小',
      intro:
        'DSH 桌面版每次启动都按写死的 1280 × 820 建窗口，也不保存窗口大小。这里设定启动尺寸：保存后立即应用一次，之后每次启动 DSH 自动应用。窗口会以当前显示器的工作区居中摆放，尺寸超过屏幕时自动收进屏幕内。',
      sizeTitle: '启动窗口尺寸',
      sizeDesc: '宽 × 高，单位是 Electron 的逻辑像素（DIP），最小 520 × 600。',
      ariaWidth: '启动窗口宽度',
      ariaHeight: '启动窗口高度',
      autoTitle: '启动时自动应用',
      autoDesc: '关掉后下次启动不再自动调整窗口；点「保存并应用」仍会立即生效。',
      save: '保存并应用',
      busy: '处理中…',
      statusBtn: '查看最近一次结果',
      errMin: '尺寸不合法：宽至少 {minW}，高至少 {minH}。',
      errMax: '尺寸不合法：宽和高都不能超过 {max}。',
      saving: '正在保存并调整窗口…',
      saveFailed: '保存设置失败：',
      applyFailed: '调整失败：',
      applied: '已调整到 {width} × {height}。',
      loadFailed: '读取设置失败：',
      statusPrefix: '最近一次记录：',
      statusEmpty: '(空)',
      statusFailed: '读取日志失败：',
      filePrefix: '设置文件：',
      unknown: '未知错误',
      'problem.config-unreadable': '设置文件读不出来，本次按默认值处理。',
      'problem.config-corrupt': '设置文件不是合法 JSON，已备份原文件并按默认值处理。',
      'error.no-connection': '无法连接 Host（插件似乎没有在 Host 里加载）。',
      'error.empty-response': 'Host 返回为空。',
      'error.rpc-failed': 'Host 通信失败。',
      'error.unsupported-platform': '只支持 Windows。',
      'error.spawn-failed': '无法启动 PowerShell 助手。',
      'error.helper-timeout': '调整超时（40 秒内没有结果），窗口可能没有变化。',
      'error.helper-failed': 'PowerShell 助手出错。',
      'error.helper-exit': 'PowerShell 助手异常退出。',
      'error.script-write-failed': '无法写入 PowerShell 助手脚本。',
      'error.config-unreadable': '无法读取设置文件，已使用默认值。',
      'error.config-corrupt': '设置文件不是合法 JSON，已使用默认值。',
      'error.gateway/bad-request': '请求格式不对（插件与 Host 版本可能不匹配）。',
      'error.unknown-method': 'Host 不支持这个操作。',
      'error.handler-failed': 'Host 处理请求时出错。',
    }

    var EN = {
      nav: 'Window size',
      intro:
        'The DSH desktop app always opens at a hard-coded 1280 × 820 window and never saves its size. Set the startup size here: saving applies it once right away, and every later launch applies it automatically. The window is centered inside the current monitor work area and clamped to fit.',
      sizeTitle: 'Startup window size',
      sizeDesc: 'Width × height in Electron logical pixels (DIP). Minimum 520 × 600.',
      ariaWidth: 'Startup window width',
      ariaHeight: 'Startup window height',
      autoTitle: 'Apply at startup',
      autoDesc: 'When off, later launches leave the window alone; "Save and apply" still resizes it now.',
      save: 'Save and apply',
      busy: 'Working…',
      statusBtn: 'Show last result',
      errMin: 'Invalid size: width must be at least {minW} and height at least {minH}.',
      errMax: 'Invalid size: width and height must not exceed {max}.',
      saving: 'Saving and resizing the window…',
      saveFailed: 'Could not save the settings: ',
      applyFailed: 'Resize failed: ',
      applied: 'Resized to {width} × {height}.',
      loadFailed: 'Could not read the settings: ',
      statusPrefix: 'Last run: ',
      statusEmpty: '(empty)',
      statusFailed: 'Could not read the log: ',
      filePrefix: 'Settings file: ',
      unknown: 'unknown error',
      'problem.config-unreadable': 'The settings file could not be read; the defaults are in effect.',
      'problem.config-corrupt': 'The settings file is not valid JSON; it was backed up and the defaults are in effect.',
      'error.no-connection': 'Cannot reach the Host (the plugin does not seem to be loaded there).',
      'error.empty-response': 'The Host returned an empty response.',
      'error.rpc-failed': 'The Host call failed.',
      'error.unsupported-platform': 'Windows only.',
      'error.spawn-failed': 'Could not start the PowerShell helper.',
      'error.helper-timeout': 'Timed out (no result within 40 s); the window may be unchanged.',
      'error.helper-failed': 'The PowerShell helper failed.',
      'error.helper-exit': 'The PowerShell helper exited unexpectedly.',
      'error.script-write-failed': 'Could not write the PowerShell helper script.',
      'error.config-unreadable': 'The settings file could not be read; the defaults are in effect.',
      'error.config-corrupt': 'The settings file is not valid JSON; the defaults are in effect.',
      'error.gateway/bad-request': 'Malformed request (plugin and Host versions may not match).',
      'error.unknown-method': 'The Host does not know this operation.',
      'error.handler-failed': 'The Host failed to handle the request.',
    }

    var DICTS = { zh: ZH, en: EN }

    /**
     * The locale service is optional: ctx.locale is a proxy field and ctx.get()
     * resolves services outside the inject list to an Error object, so accept a
     * candidate only when it actually looks like the service.
     */
    function localeService() {
      var ctx = ctxRef
      if (!ctx) return null
      var candidate = null
      try { candidate = ctx.locale || null } catch (error) { candidate = null }
      if (!candidate && typeof ctx.get === 'function') {
        try { candidate = ctx.get('locale') || null } catch (error) { candidate = null }
      }
      if (!candidate || typeof candidate !== 'object') return null
      if (
        typeof candidate.getSnapshot === 'function' ||
        typeof candidate.getLocale === 'function' ||
        typeof candidate.register === 'function' ||
        typeof candidate.bind === 'function'
      ) {
        return candidate
      }
      return null
    }

    function currentLang() {
      var service = localeService()
      if (service) {
        try {
          var snapshot =
            typeof service.getSnapshot === 'function'
              ? service.getSnapshot()
              : typeof service.getLocale === 'function'
                ? service.getLocale()
                : null
          var id = snapshot && (snapshot.active || snapshot.id || snapshot.locale)
          if (typeof id === 'string' && id) return /^zh/i.test(id) ? 'zh' : 'en'
        } catch (error) { }
      }
      var language =
        typeof navigator === 'object' && navigator && typeof navigator.language === 'string'
          ? navigator.language
          : ''
      return /^zh/i.test(language) ? 'zh' : 'en'
    }

    /** Returns undefined for a key this build does not know (callers fall back). */
    function translate(lang, key, params) {
      var table = DICTS[lang] || DICTS.en
      var text = table[key]
      if (text === undefined) text = DICTS.en[key]
      if (text === undefined) text = DICTS.zh[key]
      if (text === undefined) return undefined
      if (params) {
        for (var name in params) {
          if (!Object.prototype.hasOwnProperty.call(params, name)) continue
          text = text.split('{' + name + '}').join(String(params[name]))
        }
      }
      return text
    }

    function makeT(lang) {
      return function (key, params) {
        return translate(lang, key, params)
      }
    }

    /** Re-render the page (and the sidebar label) when DSH switches language. */
    function useLang() {
      var pair = React.useState(currentLang())
      var lang = pair[0]
      var setLang = pair[1]
      React.useEffect(function () {
        var service = localeService()
        if (!service || typeof service.subscribe !== 'function') return function () { }
        var unsubscribe = null
        try {
          unsubscribe = service.subscribe(function () { setLang(currentLang()) })
        } catch (error) { unsubscribe = null }
        return function () {
          if (typeof unsubscribe === 'function') {
            try { unsubscribe() } catch (error) { }
          }
        }
      }, [])
      return lang
    }

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
        return Promise.resolve({ ok: false, error: { code: 'no-connection', message: '' } })
      }
      return rpc.call('/api', ENDPOINT, { method: method, payload: payload || {} }).then(
        function (result) {
          if (result && typeof result === 'object') return result
          return { ok: false, error: { code: 'empty-response', message: '' } }
        },
        function (error) {
          return { ok: false, error: { code: 'rpc-failed', message: String((error && error.message) || error) } }
        }
      )
    }

    function errorText(result, t) {
      var unknown = t ? t('unknown') || 'unknown error' : 'unknown error'
      if (!result) return unknown
      if (typeof result === 'string') return result
      if (result.error) {
        if (typeof result.error === 'string') return result.error
        if (result.error.message) return String(result.error.message)
      }
      if (result.message) return String(result.message)
      try { return JSON.stringify(result).slice(0, 300) } catch (e) { return unknown }
    }

    /**
     * A translatable note: { prefix?, key?, params?, fallback?, raw?, tail?, emptyKey? }.
     * Keeping it structured (instead of a finished string) lets the note re-render
     * in the new language when DSH switches locale.
     */
    function errNote(result, t) {
      var error = result && result.error
      if (error && typeof error === 'object' && error.code) {
        return { key: 'error.' + String(error.code), fallback: errorText(result, t) }
      }
      return { raw: errorText(result, t) }
    }

    function prefixed(prefix, note) {
      var merged = { prefix: prefix }
      for (var name in note) {
        if (Object.prototype.hasOwnProperty.call(note, name)) merged[name] = note[name]
      }
      return merged
    }

    function noteText(note, t) {
      if (!note) return ''
      var text
      if (note.key) {
        var translated = t(note.key, note.params)
        text = translated !== undefined ? translated : note.fallback !== undefined ? note.fallback : ''
      } else if (note.raw !== undefined) {
        text = note.raw || (note.emptyKey ? t(note.emptyKey) || '' : '')
      } else {
        text = ''
      }
      if (note.prefix) text = (t(note.prefix) || '') + text
      if (note.tail) text += String.fromCharCode(10) + note.tail
      return text
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
      var lang = useLang()
      var t = makeT(lang)
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
      var notePair = React.useState(null)
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
        var attempts = 0
        var timer = null
        function attempt() {
          host('load').then(function (result) {
            if (!alive) return
            // The connection service may not be mounted yet while the app is
            // still starting up: retry briefly instead of showing a dead page.
            if (result && !result.ok && result.error && result.error.code === 'no-connection' && attempts < 10) {
              attempts += 1
              timer = setTimeout(attempt, 300)
              return
            }
            setLoading(false)
            if (result && result.ok && result.value && result.value.config) {
              var config = result.value.config
              setWidth(config.width)
              setHeight(config.height)
              setEnabled(config.enabled !== false)
              setFile(result.value.file || '')
              var problem = result.value.problem
              if (problem && problem.code) {
                setTone('error')
                setNote({
                  key: 'problem.' + String(problem.code),
                  fallback: String(problem.message || problem.code),
                  // The Host's own line carries the backup path; the localized
                  // sentence above does not have it.
                  tail: problem.code === 'config-corrupt' ? String(problem.message || '') : undefined,
                })
              }
            } else {
              setTone('error')
              setNote(prefixed('loadFailed', errNote(result, t)))
            }
          })
        }
        attempt()
        return function () {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      var submit = React.useCallback(
        function () {
          var w = Math.round(Number(width))
          var hh = Math.round(Number(height))
          if (!Number.isFinite(w) || !Number.isFinite(hh) || w < MIN_W || hh < MIN_H) {
            setTone('error')
            setNote({ key: 'errMin', params: { minW: MIN_W, minH: MIN_H } })
            return
          }
          if (w > MAX_SIDE || hh > MAX_SIDE) {
            setTone('error')
            setNote({ key: 'errMax', params: { max: MAX_SIDE } })
            return
          }
          var config = { width: w, height: hh, enabled: enabled !== false }
          setBusy(true)
          setTone('muted')
          setNote({ key: 'saving' })
          host('save', { config: config })
            .then(function (saved) {
              if (!saved || !saved.ok) {
                setBusy(false)
                setTone('error')
                setNote(prefixed('saveFailed', errNote(saved, t)))
                return null
              }
              // Use the config the Host actually stored (it clamps the numbers),
              // so what the page reports is what was written to disk.
              var stored = saved.value && saved.value.config ? saved.value.config : config
              return host('apply', { config: stored }).then(function (result) {
                return { stored: stored, result: result }
              })
            })
            .then(function (bundle) {
              if (!bundle) return
              setBusy(false)
              var result = bundle.result
              var applied = result && result.ok && result.value ? result.value.result : result
              var stored = (result && result.ok && result.value && result.value.config) || bundle.stored
              if (applied && applied.ok) {
                setWidth(stored.width)
                setHeight(stored.height)
                setTone('ok')
                setNote({
                  key: 'applied',
                  params: { width: stored.width, height: stored.height },
                  tail: applied.tail || undefined,
                })
              } else {
                setTone('error')
                setNote(prefixed('applyFailed', errNote(applied, t)))
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
            setNote({ prefix: 'statusPrefix', raw: result.value.tail || '', emptyKey: 'statusEmpty' })
          } else {
            setTone('error')
            setNote(prefixed('statusFailed', errNote(result, t)))
          }
        })
      }, [])

      var disabled = busy || loading

      return h(
        'div',
        { className: 'dws-root' },
        h('p', { className: 'dws-intro' }, t('intro')),
        h(
          Row,
          { title: t('sizeTitle'), desc: t('sizeDesc') },
          h(
            'div',
            { className: 'dws-size' },
            h('input', {
              className: 'dws-input',
              type: 'number',
              min: MIN_W,
              max: MAX_SIDE,
              step: 10,
              'aria-label': t('ariaWidth'),
              value: width,
              disabled: disabled,
              onChange: function (event) { setWidth(event.target.value) },
            }),
            h('span', { className: 'dws-times' }, '×'),
            h('input', {
              className: 'dws-input',
              type: 'number',
              min: MIN_H,
              max: MAX_SIDE,
              step: 10,
              'aria-label': t('ariaHeight'),
              value: height,
              disabled: disabled,
              onChange: function (event) { setHeight(event.target.value) },
            })
          )
        ),
        h(
          Row,
          { title: t('autoTitle'), desc: t('autoDesc') },
          h('input', {
            type: 'checkbox',
            'aria-label': t('autoTitle'),
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
            busy ? t('busy') : t('save')
          ),
          h(
            'button',
            { className: 'dws-btn dws-btn-ghost', type: 'button', disabled: disabled, onClick: refresh },
            t('statusBtn')
          )
        ),
        note ? h('div', { className: 'dws-note dws-note-' + tone }, noteText(note, t)) : null,
        file ? h('div', { className: 'dws-file' }, t('filePrefix') + file) : null
      )
    }

    function apply(ctx) {
      ctxRef = ctx
      var disposeStyle = injectStyle()
      var disposers = []
      var sectionDispose = null
      var localeDispose = null

      // Register the dictionary so the settings sidebar can translate the label
      // through the slot's locale namespace. Optional: without the service the
      // page still works and label() reads the language itself.
      function registerDictionary() {
        if (typeof localeDispose === 'function') return true
        var service = localeService()
        if (!service || typeof service.register !== 'function') return false
        try {
          var dispose = service.register(LOCALE_NS, { zh: ZH, en: EN })
          localeDispose = typeof dispose === 'function' ? dispose : function () { }
          return true
        } catch (error) {
          return false
        }
      }
      registerDictionary()
      if (typeof localeDispose !== 'function' && typeof ctx.inject === 'function') {
        // The locale service may arrive after this plugin mounts.
        try {
          ctx.inject(['locale'], function () { registerDictionary() })
        } catch (error) { }
      }
      try {
        disposers.push(
          ctx.slots.inject('settings.section', function () {
            // The slot can be re-injected (e.g. the settings page remounts):
            // drop the previous registration so the page never appears twice.
            if (typeof sectionDispose === 'function') {
              try { sectionDispose() } catch (error) { }
            }
            var options = {
              name: 'settings.section',
              id: 'startup-window',
              order: 95,
              label: function () { return makeT(currentLang())('nav') || 'Window size' },
              inject: function () { return {} },
            }
            if (registerDictionary()) options.locale = LOCALE_NS
            sectionDispose = ctx.slots.register(options, SettingsSection)
            return sectionDispose
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
        if (typeof sectionDispose === 'function') {
          try { sectionDispose() } catch (error) { }
        }
        sectionDispose = null
        if (typeof localeDispose === 'function') {
          try { localeDispose() } catch (error) { }
        }
        localeDispose = null
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
