// bundle-courses.mjs
// 把 src/builtin/ 下的内置课件（当前仅「墨痕使用指南」）拷贝进 public/courses/ 并生成 manifest.json。
// - 本机开发：npm run course:bundle（predev/prebuild 自动触发），覆盖 public/courses
// - CI（GitHub Actions）：源码随仓库提交，总是可用；脚本保持幂等
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SOURCE_ROOT = join(process.cwd(), 'src', 'builtin')
const OUT_PATH = join(process.cwd(), 'public', 'courses')

// 参与打包的内置课件（含各自的 INDEX.md）
const FOLDER_COURSES = [
  { id: 'guide', title: '墨痕使用指南', seal: '引', desc: '功能导览：书架、阅读、问 AI、AI 著书与导入导出', category: '入门' },
]

// 只拷贝文本扩展名；排除二进制 / 元数据以控制部署体积
const INCLUDE_EXT = new Set([
  '.md', '.txt', '.c', '.h', '.cpp', '.hpp', '.rs', '.toml', '.json',
  '.yaml', '.yml', '.csv', '.cfg', '.sh', '.py', '.S', '.asm', '.mk',
])
const EXCLUDE_NAMES = new Set(['.git', '.claude', 'target', '__pycache__'])
const MAX_FILE = 2 * 1024 * 1024 // 单文件上限 2MB

function shouldCopy(relPath) {
  const parts = relPath.split(/[\\/]/)
  if (parts.some((p) => EXCLUDE_NAMES.has(p))) return false
  if (relPath.endsWith('.zip')) return false
  const base = parts[parts.length - 1]
  if (!base.includes('.')) {
    // 无扩展名：Makefile 之类允许
    return base === 'Makefile'
  }
  const ext = '.' + (base.split('.').pop() || '').toLowerCase()
  return INCLUDE_EXT.has(ext)
}

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    // manifest 里的路径恒为 posix 分隔符（Windows 上 relative() 会给反斜杠，直接写进 manifest 会让前端路径解析全挂）
    const rel = relative(base, abs).split(sep).join('/')
    if (EXCLUDE_NAMES.has(name)) continue
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(abs, base, out)
    } else if (st.size <= MAX_FILE && shouldCopy(rel)) {
      out.push(rel)
    }
  }
}

function copyCourse(srcDir, id) {
  const dest = join(OUT_PATH, id)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  if (!existsSync(srcDir)) {
    console.warn(`  ⚠ 内置课件源不存在，跳过：${srcDir}`)
    return []
  }
  const files = []
  walk(srcDir, srcDir, files)
  for (const rel of files) {
    const from = join(srcDir, rel)
    const to = join(dest, rel)
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to)
  }
  console.log(`  copied ${id}: ${files.length} files`)
  return files
}

function main() {
  console.log(`Bundling builtin courses from ${SOURCE_ROOT}`)
  rmSync(OUT_PATH, { recursive: true, force: true })
  mkdirSync(OUT_PATH, { recursive: true })

  const manifest = { version: 1, courses: [] }

  for (const c of FOLDER_COURSES) {
    const files = copyCourse(join(SOURCE_ROOT, c.id), c.id)
    manifest.courses.push({ ...c, kind: 'dir', fileCount: files.length, files: files.sort(), format: 'md' })
  }

  writeFileSync(
    join(OUT_PATH, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  )
  console.log(`\nManifest: ${manifest.courses.length} courses`)
  console.log(`Output: ${OUT_PATH}`)
}

main()
