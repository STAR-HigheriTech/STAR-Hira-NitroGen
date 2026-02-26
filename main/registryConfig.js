var regedit = require('regedit')

var installPath = process.execPath

var legacyKeysToDelete = [
  'HKCU\\Software\\Clients\\StartMenuInternet\\HigheriBrowser',
  'HKCU\\Software\\Classes\\HigheriBrowser',
  'HKCU\\Software\\Classes\\Hira\\DefaulIcon'
]

var keysToCreate = [
  'HKCU\\Software\\Classes\\Hira',
  'HKCU\\Software\\Classes\\Hira\\Application',
  'HKCU\\Software\\Classes\\Hira\\DefaultIcon',
  'HKCU\\Software\\Classes\\Hira\\shell\\open\\command',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\FileAssociations',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\StartMenu',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\URLAssociations',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\DefaultIcon',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\InstallInfo',
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\shell\\open\\command'
]

var registryConfig = {
  'HKCU\\Software\\RegisteredApplications': {
    Hira: {
      value: 'Software\\Clients\\StartMenuInternet\\Hira\\Capabilities',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Classes\\Hira': {
    default: {
      value: 'Hira Document',
      type: 'REG_DEFAULT'
    }
  },
  'HKCU\\Software\\Classes\\Hira\\Application': {
    ApplicationIcon: {
      value: installPath + ',0',
      type: 'REG_SZ'
    },
    ApplicationName: {
      value: 'Hira',
      type: 'REG_SZ'
    },
    AppUserModelId: {
      value: 'Hira',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Classes\\Hira\\DefaultIcon': {
    default: {
      value: installPath + ',0',
      type: 'REG_DEFAULT'
    }
  },
  'HKCU\\Software\\Classes\\Hira\\shell\\open\\command': {
    default: {
      value: '"' + installPath + '" "%1"',
      type: 'REG_DEFAULT'
    }
  },
  'HKCU\\Software\\Classes\\.htm\\OpenWithProgIds': {
    Hira: {
      value: 'Empty',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Classes\\.html\\OpenWithProgIds': {
    Hira: {
      value: 'Empty',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\FileAssociations': {
    '.htm': {
      value: 'Hira',
      type: 'REG_SZ'
    },
    '.html': {
      value: 'Hira',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\StartMenu': {
    StartMenuInternet: {
      value: 'Hira',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\URLAssociations': {
    http: {
      value: 'Hira',
      type: 'REG_SZ'
    },
    https: {
      value: 'Hira',
      type: 'REG_SZ'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\DefaultIcon': {
    default: {
      value: installPath + ',0',
      type: 'REG_DEFAULT'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\InstallInfo': {
    IconsVisible: {
      value: 1,
      type: 'REG_DWORD'
    }
  },
  'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\shell\\open\\command': {
    default: {
      value: '"' + installPath + '" "%1"',
      type: 'REG_DEFAULT'
    }
  }
}

var registryInstaller = {
  install: function () {
    return new Promise(function (resolve, reject) {
      regedit.deleteKey(legacyKeysToDelete, function () {
        regedit.createKey(keysToCreate, function (err) {
          if (err) {
            reject(err)
            return
          }
          regedit.putValue(registryConfig, function (putError) {
            if (putError) {
              reject(putError)
            } else {
              resolve()
            }
          })
        })
      })
    })
  },
  ensureInstalled: function () {
    return new Promise(function (resolve) {
      var keysToCheck = [
        'HKCU\\Software\\RegisteredApplications',
        'HKCU\\Software\\Classes\\Hira',
        'HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\FileAssociations'
      ]

      regedit.list(keysToCheck, function (err, result) {
        if (err || !result) {
          registryInstaller.install().then(function () {
            resolve(true)
          }).catch(function () {
            resolve(false)
          })
          return
        }

        var registeredApps = result['HKCU\\Software\\RegisteredApplications']
        var hasRegisteredApp = registeredApps && registeredApps.values && registeredApps.values.Hira && registeredApps.values.Hira.value === 'Software\\Clients\\StartMenuInternet\\Hira\\Capabilities'
        var classKey = result['HKCU\\Software\\Classes\\Hira']
        var hasClassKey = classKey && classKey.exists
        var fileAssocKey = result['HKCU\\Software\\Clients\\StartMenuInternet\\Hira\\Capabilities\\FileAssociations']
        var hasFileAssociations = fileAssocKey && fileAssocKey.exists

        if (hasRegisteredApp && hasClassKey && hasFileAssociations) {
          resolve(true)
          return
        }

        registryInstaller.install().then(function () {
          resolve(true)
        }).catch(function () {
          resolve(false)
        })
      })
    })
  },
  uninstall: function () {
    return new Promise(function (resolve, reject) {
      regedit.deleteKey(keysToCreate, function (err) {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }
}

global.registryInstaller = registryInstaller
