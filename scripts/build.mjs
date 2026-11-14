#!/usr/bin/env node
/**
 * 构建脚本：Host 产物用 tsc，浏览器产物用 esbuild 打成 Loader 识别的单文件。
 *
 * 为什么不能只用 tsc：DSH 的客户端模块不是 ESM 文件，而是一个
 * `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 包装；浏览器
 * 端没有相对路径解析，`lib/client/*.js` 之间的 `require('./x.js')` 会失败。因此
 * 客户端源码必须打成自包含的一份文件，并只把 react / react/jsx-runtime 留给
 * 宿主的静态模块表（`dsh.client.external` 不涉及这两个基线模块）。
 *
 * `lib/client.js` 是构建产物，不入库；`npm test` 会先跑本脚本，e2e 用例读到的
 * 是最新产物。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** 仓库根目录。 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 包清单；客户端模块 id 必须等于包名，因此从清单读取而不是硬编码。 */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 先清空：删掉的源文件不能以旧产物的形式继续被加载。
rmSync(join(root, 'lib'), { recursive: true, force: true })

// Host 产物：tsc 按 tsconfig 输出 ESM + 类型声明。
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'firefox115', 'safari16'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  // 宿主静态模块表提供的基线模块：不重复打包，运行时由 factory 的 require 取。
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
  logLevel: 'warning',
})

const output = result.outputFiles?.[0]
if (output === undefined) throw new Error('esbuild 未产出客户端模块')

// 与 DSH 官方客户端包一致的包装：shim 出 CJS 的 module/exports，再把导出对象
// 作为插件定义交还给加载器。
const banner = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:require=>{var module={exports:{}};var exports=module.exports;\n`
const footer = '\nreturn module.exports}});\n'
writeFileSync(join(root, 'lib', 'client.js'), banner + output.text + footer)

// 只打印体积，避免把产物贴进日志。
const bytes = Buffer.byteLength(output.text, 'utf8')
console.log(`[session-messaging] lib/client.js 已生成（${bytes} 字节）`)
