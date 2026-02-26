const fs = require('fs')
const archiver = require('archiver')
const builder = require('electron-builder')
const Arch = builder.Arch
const Platform = builder.Platform

const packageFile = require('./../package.json')
const version = packageFile.version

const createPackage = require('./createPackage.js')

async function afterPackageBuilt (packagePath) {
  if (!fs.existsSync('dist/app')) {
    fs.mkdirSync('dist/app')
  }

  let archSuffix
  let arch

  if (packagePath.includes('ia32')) {
    archSuffix = '-ia32'
    arch = Arch.ia32
  } else if (packagePath.includes('arm64')) {
    archSuffix = '-arm64'
    arch = Arch.arm64
  } else {
    archSuffix = ''
    arch = Arch.x64
  }

  const output = fs.createWriteStream('dist/app/' + 'Hira-v' + version + '-windows' + archSuffix + '.zip')
  const archive = archiver('zip', {
    zlib: { level: 9 }
  })
  archive.directory(packagePath, 'Hira-v' + version)
  archive.pipe(output)
  await archive.finalize()

  const options = {
    appId: 'com.starhigheritech.higheribrowser',
    productName: 'Hira',
    win: {
      target: ['nsis'],
      icon: 'icons/icon256.ico'
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Hira',
      artifactName: 'Hira-${version}' + archSuffix + '-setup.exe'
    },
    fileAssociations: [
      {
        ext: 'html',
        name: 'HTML Document',
        description: 'HTML Document',
        role: 'Viewer'
      },
      {
        ext: 'htm',
        name: 'HTML Document',
        description: 'HTML Document',
        role: 'Viewer'
      }
    ],
    protocols: [
      {
        name: 'HTTP Protocol',
        schemes: ['http']
      },
      {
        name: 'HTTPS Protocol',
        schemes: ['https']
      }
    ],
    directories: {
      output: 'dist/app/'
    },
    publish: null
  }

  console.log('Creating installer (this may take a while)')

  fs.copyFileSync('LICENSE.txt', packagePath + '/LICENSE')

  await builder.build({
    prepackaged: packagePath,
    targets: Platform.WINDOWS.createTarget(['nsis'], arch),
    config: options
  })
    .then(() => console.log('Successfully created installer.'))
    .catch(err => {
      console.error(err, err.stack)
      process.exit(1)
    })
}

createPackage('win32', { arch: Arch.x64 })
  .then(afterPackageBuilt)
