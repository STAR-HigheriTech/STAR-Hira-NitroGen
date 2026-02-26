let proxyConfig = { mode: 'system' }

settings.listen('proxy', (proxy = {}) => {
  if (!('type' in proxy)) {
    proxyConfig = { mode: 'system' }
  } else {
    switch (proxy.type) {
      case 0:
        proxyConfig = { mode: 'system' }
        break
      case 1:
        proxyConfig = {
          mode: 'direct'
        }
        break
      case 2:
        proxyConfig = {
          mode: 'fixed_servers',
          pacScript: '',
          proxyRules: proxy.proxyRules,
          proxyBypassRules: proxy.proxyBypassRules
        }
        break
      case 3:
        proxyConfig = {
          mode: 'pac_script',
          pacScript: proxy.pacScript
        }
        break
      default:
        proxyConfig = { mode: 'system' }
    }
  }

  webContents.getAllWebContents().forEach(wc => wc.session && wc.session.setProxy(proxyConfig))
})

app.on('session-created', session => session.setProxy(proxyConfig))
