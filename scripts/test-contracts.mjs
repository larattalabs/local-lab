import { spawnSync } from 'node:child_process'
const suites = ['basic','basic-flow','director','director-flow','studio','history-reset','phone-access',
  'image-stack','video-workflow','qwen-runtime','video-performance','review']
for (const name of suites) {
  const result = spawnSync(process.execPath,['scripts/test-'+name+'.mjs'],{stdio:'inherit'})
  if (result.status !== 0) process.exit(result.status ?? 1)
}
for (const name of ['video-setup','qwen-encoder','ds4-worker']) {
  const result = spawnSync('python3',['scripts/test-'+name+'.py'],{stdio:'inherit'})
  if (result.status !== 0) process.exit(result.status ?? 1)
}
