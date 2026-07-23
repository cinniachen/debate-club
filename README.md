# 随地大小辩 · 网络辩论赛小工具

一个服务小团体的轻量级网络辩论赛工具：凑人开赛、共享辩题、赛前准备、辩论计时，还内置 AI 模拟对辩陪练。纯本地运行，零外部数据库依赖。

> 适合辩论社团 / 朋友小群办赛，先跑起来再慢慢迭代。

## ✨ 功能特性

| 模块 | 说明 |
|------|------|
| 📋 报名参赛 | 发起比赛（时间 / 辩题 / 人数 / 赛制），凑齐即开赛 |
| 💡 辩题广场 | 上传辩题、点赞，高赞辩题可设为下场题目（公开共享） |
| 🔒 赛前准备 | 论点笔记（按辩题分文件夹）+ AI 模拟对辩，仅自己可见 |
| ⏱️ 辩论工具 | 各环节倒计时器，预设多种赛制计时方案 |
| 📖 新手引导 | 辩论小白友好的规则与流程说明 |
| 🤖 AI 模拟对辩 | 正 / 反方陪练，可切「普通 / 深度思考」引擎，支持🎤语音输入 |

## 🚀 快速开始

要求 **Node.js 18+**（推荐 22）。

```bash
# 1. 安装依赖
npm install

# 2.（可选）配置 DeepSeek，启用真实大模型对辩
cp .env.example .env
# 然后编辑 .env，把 DEEPSEEK_API_KEY 换成你的真实 Key
# 不配置也能用，只是 AI 对辩会回退到内置模板话术

# 3. 启动
node server.js
# 或者 npm start

# 4. 浏览器打开
# http://localhost:3456
```

## 🔧 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `DEEPSEEK_API_KEY` | 否 | 无 | DeepSeek API Key。不填则 AI 对辩使用内置模板话术 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | 自定义 API 接入地址（如代理） |
| `PORT` | 否 | `3456` | 服务端口 |

> 获取 Key：https://platform.deepseek.com

## ⚔️ 赛制

内置多种赛制，创建比赛时可选择：

- **经典四辩**（默认）：陈词 → 质询 → 对辩 → 质询小结 → 自由辩论 → 总结，共 16 个计时环节，每方 4 人
- **标准 / 快速 / BP / 自定义**：按不同流程风格计时

计时器预设按钮可一键套用对应赛制的环节计时。

## 📁 目录结构

```
debate-club/
├── server.js          # Express 后端，所有 REST API + 轻量 .env 读取
├── public/
│   └── index.html      # 前端单页应用（五大功能 tab + 计时器 + AI 对辩）
├── data/
│   └── db.json         # 本地 JSON 存储（events / topics / notes / ai_history ...）
├── .env.example        # 配置模板（复制为 .env 后填 Key）
├── .gitignore          # 已忽略 .env / node_modules / .DS_Store
└── package.json
```

## 🧱 技术栈

- **后端**：Node.js + Express，JSON 文件存储（无数据库）
- **前端**：原生 HTML / CSS / JS 单页应用，无构建步骤
- **AI 对辩**：DeepSeek API（OpenAI 兼容格式），无 Key 时回退模板
- **语音输入**：浏览器原生 Web Speech API

## ⚠️ 注意事项

1. **准备区隔离是轻量身份**：笔记与 AI 对辩历史按「昵称」隔离，用于区分多人练习记录，**非强鉴权**，不要当作私密数据保险箱。
2. **语音输入需安全上下文**：Web Speech API 在 `localhost` 或 `https` 下可用；部署到非 https 域名会失效，建议用 Chrome / Edge。
3. **`.env` 含密钥，已 gitignore**：切勿手动把 `.env` 提交到仓库。
4. **本地数据在 `data/db.json`**：重置时直接清空该文件即可，不影响代码。

## 📡 API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/events` | 比赛报名 |
| GET/POST | `/api/topics` | 辩题广场 |
| GET/POST/PUT/DELETE | `/api/notes` | 论点笔记（按昵称隔离，带 `X-User` 头） |
| GET/POST/DELETE | `/api/ai-history` | AI 对辩历史（私有） |
| POST | `/api/ai-debate` | AI 模拟对辩（模板或 DeepSeek） |
| GET | `/api/ai-status` | 返回是否已配置 DeepSeek Key |
| GET | `/api/debate-formats` | 赛制与计时方案 |
