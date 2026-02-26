# Hira

Hira is a fast, minimal browser by STAR HigheriTech that protects your
privacy. It includes an interface designed to minimize distractions, and
features such as:

- Full-text search for visited pages
- Ad and tracker blocking
- Automatic reader view
- Spaces (tab groups)
- Bookmark tagging
- Password manager integration
- Dark theme

Download Hira from the
[releases page](https://github.com/HigheriTech/HigheriBrowser/releases), or
learn more on the [website](https://www.higheri.tech/).

[![Downloads][DownloadsBadge]][DownloadsUrl]

## Installing

You can find prebuilt binaries for Hira
[here](https://github.com/HigheriTech/HigheriBrowser/releases). Alternatively,
skip to the section below for instructions on how to build Hira
directly from source.

### Installation on Linux

- To install the .deb file, use `sudo dpkg -i /path/to/download`
- To install the RPM build, use `sudo rpm -i /path/to/download --ignoreos`

## Getting Started

- Learn more about Hira at https://www.higheri.tech/.
- If you're experiencing a bug or have a suggestion, open an issue at
  https://github.com/HigheriTech/HigheriBrowser/issues.

## Developing

If you want to develop Hira:

- Install [Node](https://nodejs.org).
- Run `npm install` to install dependencies.
- Start Hira in development mode by running `npm run start`.
- After you make changes, press `alt+ctrl+r` (or `opt+cmd+r` on Mac) to reload
  the browser UI.

### Building binaries

In order to build Hira from source, follow the installation
instructions above, then use one of the following commands to create binaries:

- `npm run buildWindows`
- `npm run buildMacIntel`
- `npm run buildMacArm`
- `npm run buildDebian`
- `npm run buildRaspi` (for 32-bit Raspberry Pi)
- `npm run buildLinuxArm64` (for 64-bit Raspberry Pi or other ARM Linux)
- `npm run buildRedhat`

Depending on the platform you are building for, you may need to install
additional dependencies:

- If you are building a macOS package, you'll need to install Xcode and the
  associated command-line tools. You may also need to set your default SDK to
  macOS 11.0 or higher, which you can do by running
  `export SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX11.1.sdk`.
  The exact command will depend on where Xcode is installed and which SDK
  version you're using.
- To build on Windows, you'll need to install Visual Studio. Once it's
  installed, you may also need to run `npm config set msvs_version 2019` (or the
  appropriate version).

## Contributing to Hira

Thanks for taking the time to contribute to Hira!

### Getting Help

If you're experiencing a bug or have a suggestion for how to improve
Hira, please open a
[new issue](https://github.com/HigheriTech/HigheriBrowser/issues/new/choose).

### Contributing Code

- Start by following the development instructions listed above.
- Hira uses the [Standard](https://github.com/feross/standard) code
  style; [most editors](https://standardjs.com/#are-there-text-editor-plugins)
  have plugins available to auto-format your code.
- If you see something that's missing, or run into any problems, please open an
  issue!

### Contributing Translations

#### Adding a new language

- Find the language code that goes with your language from
  [this list](https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc;l=55)
  (line 55 - 230).
- In the `localization/languages` directory, create a new file, and name it
  "[your language code].json".
- Open your new file, and copy the contents of the
  <a href="localization/languages/en-US.json">localization/languages/en-US.json</a>
  file into your new file.
- Change the "identifier" field in the new file to the language code from
  step 1.
- Inside the file, replace each English string in the right-hand column with the
  equivalent translation.
- (Optional) See your translations live by following the
  [development instructions](#installing) above. Hira will display in
  the same language as your operating system, so make sure your computer is set
  to the same language that you're translating.
- That's it! Make a pull request with your changes.

#### Updating an existing language

- Find the language file for your language in the `localization/languages`
  directory.
- Look through the file for any items that have a value of "null", or that have
  a comment saying "missing translation".
- For each of these items, look for the item with the same name in the
  `en-US.json` file.
- Translate the value from the English file, replace "null" with your
  translation, and remove the "missing translation" comment.
- Make a pull request with the updated file.

[DownloadsBadge]: https://img.shields.io/github/downloads/HigheriTech/HigheriBrowser/total.svg
[DownloadsUrl]: https://github.com/HigheriTech/HigheriBrowser/releases
