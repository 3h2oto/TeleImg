# TeleImg

TeleImg 现已重写为 **Astro + Cloudflare Pages** 项目，同时保留原有的 Cloudflare Pages Functions 路由，用于上传、文件代理和后台管理。

## 本次重写内容

- 用 Astro 取代旧的静态 / Nuxt 打包产物。
- 保留旧入口，尽量不破坏现有使用方式：
  - `/`
  - `/index-md.html`
  - `/admin`
  - `/admin.html`
  - `/admin-imgtc.html`
  - `/admin-waterfall.html`
  - `/upload`
  - `/file/:id`
  - `/api/manage/*`
- 删除了容易把请求链路搞坏的 Sentry 遥测中间件。
- 修复重命名接口，正确读取 `?newName=`。
- 增加列表、重命名、收藏切换、文件访问、上传校验的自动化测试。

## 技术栈

- Astro 6
- Cloudflare Pages Functions
- Wrangler 4
- Vitest

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 准备环境变量

```bash
cp .dev.vars.example .dev.vars
```

必填：

- `TG_Bot_Token`
- `TG_Chat_ID`

可选：

- `BASIC_USER`
- `BASIC_PASS`
- `ModerateContentApiKey`
- `WhiteList_Mode`

### 3. 仅启动 Astro 前端

```bash
npm run dev
```

### 4. 启动完整的 Pages 本地运行时

```bash
npm run build
wrangler pages dev dist
```

这个模式会加载 Pages Functions、KV 绑定和 `.dev.vars`。

## 测试

```bash
npm run check
npm test
npm run build
```

## 部署到 Cloudflare Pages

### 构建设置

- Build command: `npm run build`
- Output directory: `dist`

### 绑定

创建一个 KV Namespace，并绑定为：

- `img_url`

### 环境变量

在 Pages 面板里设置与你本地一致的环境变量。

## 复用已有 Pages 项目

如果你已经有现成的 Pages 项目，可以把它的配置下载下来做本地联调：

```bash
wrangler pages download config <project-name>
```

注意：**不要把下载到的密钥直接提交进仓库**。把密钥放进本地 `.dev.vars` 即可。

## CI

GitHub Actions 会执行：

- `npm ci`
- `npm run check`
- `npm test`
- `npm run build`

## Telegram 应用内直传

如果要把 Telegram 应用里直接发到群/频道的媒体自动收录进后台，请先部署新版本，然后在 `/admin` 里配置 webhook。

重要限制：

- 对 **群组 / 超级群**，必须先到 **BotFather -> /setprivacy -> Disable** 关闭隐私模式，否则 Telegram 不会把普通用户发的媒体消息推给 bot。
- 对 **频道**，bot 必须是管理员，这样才能收到 `channel_post` 更新，并且后续才能删除原消息。
- 对于 bot 从未见过的老历史消息，Telegram Bot API 不能提供完整历史回溯，所以无法凭空重建全部旧记录。
