// tools/compile-bytenode.mjs （服务端）
// 把 tsc 编译产物 dist/**/*.js 全部编译成 V8 字节码(.jsc) 二进制，原 .js 替换为 loader。
// 模块间 require('xxx.js') → 加载 loader → 加载 'xxx.jsc'，链式全部走字节码。
// 运行时解包拿到的是字节码，无法直接还原成明文 JS。
// 服务端是纯 Node：用本机 node（与运行环境 node 22 同系）编译即可。
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const cli = path.resolve('node_modules/bytenode/lib/cli.js')

function compileAll(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) {
      compileAll(p)
    } else if (f.name.endsWith('.js')) {
      execSync(`node "${cli}" -c "${p}"`, { stdio: 'inherit' })
      const base = f.name.replace(/\.js$/, '.jsc')
      // loader：先注册 .jsc 扩展，再加载对应字节码模块
      const loader = `require('bytenode');\nrequire('./${base}')`
      fs.writeFileSync(p, loader, 'utf8')
      console.log('[obf]', p.replace(/\\/g, '/'), '->', base)
    }
  }
}

compileAll(path.resolve('dist'))
console.log('[obf] done')
