// Personal Mac builds use an ad-hoc signature, without Apple account credentials.
// Reuse electron-builder's own signer and entitlement handling for nested binaries.
const { createRequire } = require('node:module')
const builderRequire = createRequire(require.resolve('electron-builder'))
const signingRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const { signAsync } = signingRequire('@electron/osx-sign')

exports.sign = (options) => signAsync({ ...options, identity: '-', identityValidation: false })
