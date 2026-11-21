import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

/** Private CA is unique to this Mac and never installed into the Mac's trust store. */
export function certificates(dir: string, hosts: string[]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const p = (name: string) => join(dir, name)
  const openssl = existsSync('/opt/homebrew/bin/openssl') ? '/opt/homebrew/bin/openssl' : '/usr/bin/openssl'
  const run = (...args: string[]) => execFileSync(openssl, args, { stdio: 'pipe' })
  if (!existsSync(p('ca.pem'))) {
    // A config file instead of -addext: OpenSSL 1.1.1 appends -addext to its default CA section, which
    // produces duplicate extensions that modern verifiers reject. This lists exactly the CA's extensions.
    writeFileSync(p('ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\n'
      + 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
    run('req', '-x509', '-config', p('ca.cnf'), '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=Local Lab private Wi-Fi CA', '-keyout', p('ca.key'), '-out', p('ca.pem'))
    chmodSync(p('ca.key'), 0o600)
  }
  const identity = hosts.join(',')
  let renew = true
  try {
    const cert = new X509Certificate(readFileSync(p('server.pem')))
    renew = readFileSync(p('hosts'), 'utf8') !== identity || Date.parse(cert.validTo) < Date.now() + 7 * 86400000
  } catch { /* first use */ }
  if (renew) {
    const alt = hosts.map((h) => `${/^\d+\.\d+\.\d+\.\d+$/.test(h) ? 'IP' : 'DNS'}:${h}`).join(',')
    writeFileSync(p('server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\nsubjectAltName=${alt}\n`)
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=Local Lab',
      '-keyout', p('server.key'), '-out', p('server.csr'))
    chmodSync(p('server.key'), 0o600)
    run('x509', '-req', '-in', p('server.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'),
      '-CAcreateserial', '-out', p('server.pem'), '-days', '365', '-sha256', '-extfile', p('server.ext'))
    writeFileSync(p('hosts'), identity)
  }
  const ca = new X509Certificate(readFileSync(p('ca.pem')))
  writeFileSync(p('Local Lab Wi-Fi.cer'), ca.raw)
  return { key: readFileSync(p('server.key')), cert: readFileSync(p('server.pem')),
    ca: readFileSync(p('ca.pem')), der: ca.raw, fingerprint: ca.fingerprint256 }
}
