<div align="center">

# Atramentum · 墨痕

**A BYOK AI study companion — read, ask, and write with AI. All in your browser.**

**BYOK AI 陪学站——读书、问学、著书，全部在你的浏览器里完成。**

[![Test](https://github.com/YUZHEthefool/atramentum/actions/workflows/test.yml/badge.svg)](https://github.com/YUZHEthefool/atramentum/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Live / 在线体验**: <https://atramentum.pages.dev/#/>

</div>

---

> **Language / 语言**: English (below) · [中文说明（往下翻）](#中文)

## English

**Atramentum** (墨痕, "ink trace") is a fully static reading & AI study companion. No server, no account, no database — your courses, books, notes and API keys never leave your browser. Bring your own AI key (OpenAI-compatible or Anthropic) and the site becomes a personal tutor that reads along with you.

### Highlights

- **📚 Bookshelf** — Your courses and books, grouped by categories you create. Drag cards between categories to organize; ink-seal style covers with a custom drag ghost.
- **📖 Reader** — A three-pane reading view: TOC tree on the left, typography-focused prose in the middle (code highlighting, ASCII diagrams as monolith blocks), and an AI panel on the right. Markdown relative links navigate inside the app.
- **🤖 Ask AI (agent mode)** — Select any text and tap the floating 「问」 seal, or ask freely: the AI gets read-only tools to browse / search / read the current course and answers with a visible step-by-step workflow timeline.
- **✍️ Rewrite section** — Let AI rewrite the current section; review the streaming result and only apply it when satisfied.
- **🖋️ AI writing (AI 著书)** — Give a topic, get a lesson plan (discuss & revise it with AI first), then lessons are streamed one by one into a complete book. Continue an unfinished book, or rewrite an entire book against your own requirements.
- **🎨 Style skills** — Distill a reusable "writing style spec" from an existing course (voice, structure, diagram habits), inject it into generation so new books sound the same. A default style is built in.
- **📥 Import / 📤 Export** — zip / tar.gz / rar archives, folders, PDFs (page text) and EPUBs (chaptered). Export any course back as a zip. Keys never leak into exports.

### Privacy & data

| Data | Stored in | Leaves your browser? |
|------|-----------|----------------------|
| Imported courses & books | IndexedDB | No |
| Categories & skills | localStorage | No |
| AI endpoint & API key | localStorage | No |
| Built-in guide | Site static assets | Ships with the site |

The AI client connects **directly from your browser** to the endpoint you configure (OpenAI-compatible or Anthropic BYOK). There is no backend that could see your keys or content. To move to another device, export your content as zip and re-import.

### Quick start

Open <https://atramentum.pages.dev/#/>, click **Settings**, pick a provider preset (DeepSeek / OpenAI / Qwen / GLM / Claude) or a custom endpoint, paste your API key, and test the connection. Then start with the built-in **Guide** course on the bookshelf.

### Development

```bash
npm install
npm run dev        # start dev server (auto-bundles the built-in guide)
npm run typecheck  # tsc project references
npm test           # vitest unit tests (pure-logic modules)
npm run build      # production build to dist/
```

Node.js 20+ recommended. The built-in guide course lives in `src/builtin/guide/` and is bundled into `public/courses/` by `scripts/bundle-courses.mjs` (runs automatically before dev/build).

### Deploying to Cloudflare Pages (manual)

1. Push this repo to GitHub, then in the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, select the repo.
2. Build settings: build command `npm run build`, output directory `dist` (wrangler.toml in the repo carries the same config).
3. After the first deploy the site is served at `https://<project>.pages.dev` — every push to `main` redeploys automatically.

CI runs typecheck / tests / build on push and PRs (`.github/workflows/test.yml`); deployment itself is managed from the Cloudflare console.

### License

Licensed under the [Apache License 2.0](LICENSE).

---

## 中文

**墨痕（Atramentum）** 是一个完全静态的阅读 + AI 陪学站。没有服务器、没有账号、没有数据库——你的课件、书籍与 API 密钥从不离开浏览器。带上你自己的 AI 密钥（OpenAI 兼容或 Anthropic），它就成为一名陪你读书的私人教师。

### 功能一览

- **📚 书架**——课件与书籍按你自建的分类陈列，卡片拖拽归档，墨色印章封面与自定义拖影。
- **📖 阅读器**——三栏阅读视图：左侧目录树、中间排印正文（代码高亮、ASCII 碑刻图等宽呈现）、右侧 AI 面板；Markdown 相对链接在应用内跳转。
- **🤖 问 AI（Agent 模式）**——划词点浮出的「问」印，或自由提问：AI 拿到三只只读工具（浏览 / 检索 / 读文件），自主翻阅当前课件作答，全过程以「工作流程」时间线展示。
- **✍️ 改写本节**——让 AI 重写当前小节，流式预览、满意才应用写回。
- **🖋️ AI 著书**——给一个主题先出课时规划（可和 AI 商量修改），确认后逐课时流式成书；支持续写未完的书，或按你的要求整书改写。
- **🎨 风格 skill**——从现有课件提炼可复用的「写作风格规范」（文风、骨架、图示习惯），注入生成让新书延续同样风格；内置默认风格开箱即用。
- **📥 导入 / 📤 导出**——zip / tar.gz / rar 压缩包、文件夹、PDF（逐页文本）、EPUB（按章）；任何课件可导出回 zip。密钥永不进导出文件。

### 隐私与数据

| 数据 | 存放位置 | 会离开浏览器吗 |
|------|----------|----------------|
| 导入的课件与书籍 | IndexedDB | 否 |
| 分类与风格 skill | localStorage | 否 |
| AI 端点与密钥 | localStorage | 否 |
| 内置指南 | 站点静态资源 | 随站点携带 |

AI 客户端**从你的浏览器直连**你配置的端点（OpenAI 兼容 / Anthropic BYOK），没有任何可以窥探密钥或内容的服务端。换设备时把内容导出为 zip 再导入即可。

### 快速上手

打开 <https://atramentum.pages.dev/#/>，点「设 置」，选服务商预设（DeepSeek / OpenAI / 通义 / 智谱 / Claude）或自定义端点，填入 API Key 并测试连通。然后从书架上内置的《墨痕使用指南》开始。

### 本地开发

```bash
npm install
npm run dev        # 启动开发服务器（自动打包内置指南）
npm run typecheck  # tsc project references
npm test           # vitest 单元测试（纯逻辑模块）
npm run build      # 产线构建到 dist/
```

建议 Node.js 20+。内置指南课件在 `src/builtin/guide/`，由 `scripts/bundle-courses.mjs` 打包进 `public/courses/`（dev/build 前自动执行）。

### 部署到 Cloudflare Pages（手动）

1. 把仓库推到 GitHub，然后在 Cloudflare 控制台：**Workers & Pages → Create → Pages → Connect to Git**，选择本仓库。
2. 构建设置：构建命令 `npm run build`，输出目录 `dist`（仓库内 wrangler.toml 携带同样配置）。
3. 首次部署后站点在 `https://<项目名>.pages.dev`，此后每次推送到 `main` 自动重新部署。

CI 在 push / PR 时运行 typecheck / 测试 / 构建（`.github/workflows/test.yml`）；部署本身由 Cloudflare 控制台管理。

### 许可

基于 [Apache License 2.0](LICENSE) 开源。
