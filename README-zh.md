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
- `TG_WEBHOOK_SECRET`
- `TG_MT_BRIDGE_URL`
- `TG_MT_BRIDGE_SECRET`

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

## 大文件的 MTProto 回退下载

Telegram Bot API 对超大媒体会直接返回 `Bad Request: file is too big`。现在这个项目支持一个可选的 **Rust MTProto bridge**：当 `/file/:id` 遇到这类 Telegram 应用内直传大文件时，会改为跳转到一个带签名的 Telegram 用户会话下载链路。

### 职责划分

- **Cloudflare Pages**：继续负责普通上传、后台、签名、Bot API 文件访问。
- **独立 Rust MTProto bridge**：部署在你自己的 VPS 上，校验短时效签名，再用 Telegram 用户会话下载超大媒体。

这不是绕弯子，这是把有状态的 Telegram 用户登录放到该放的地方，别把 Pages Functions 搞成一团泥。

### 1. 先生成 Telegram 用户会话文件

先到 `https://my.telegram.org` 创建你自己的 Telegram API ID / Hash，然后执行：

```bash
cargo run --manifest-path mtproto-bridge-rs/Cargo.toml --bin teleimg-mtproto-login -- \
  --api-id 123456 \
  --api-hash your_hash \
  --session-file ./teleimg-user.session
```

你也可以继续用 npm 包一层的快捷命令：

```bash
TG_USER_API_ID=123456 \
TG_USER_API_HASH=your_hash \
TG_USER_SESSION_FILE=./teleimg-user.session \
npm run mtproto:login
```

这一步会生成持久化的 SQLite 会话文件，比如 `teleimg-user.session`。**不要提交进仓库**。

### 2. 在 VPS 上安装并运行 Rust bridge

先把 release 二进制安装到 VPS：

```bash
cargo install --path mtproto-bridge-rs --root /usr/local
```

直接运行：

```bash
TG_MT_BRIDGE_BIND=127.0.0.1:8788 \
TG_MT_BRIDGE_SECRET=replace_with_long_random_secret \
TG_USER_API_ID=123456 \
TG_USER_SESSION_FILE=/var/lib/teleimg/teleimg-user.session \
/usr/local/bin/teleimg-mtproto-bridge
```

健康检查：

```bash
curl http://127.0.0.1:8788/healthz
```

要点：

- bridge 运行时只需要 `TG_USER_API_ID`、SQLite `TG_USER_SESSION_FILE`、`TG_MT_BRIDGE_SECRET`。
- `TG_USER_API_HASH` 只在首次登录/生成会话文件时需要。
- 安全默认绑定是 `127.0.0.1`，对外暴露请走 Caddy 或 Nginx 的 HTTPS 反代。

### 3. 公开暴露 bridge

仓库里已经给了示例文件：

- `ops/systemd/teleimg-mtproto-bridge.service.example`
- `ops/systemd/mtproto-bridge.env.example`
- `ops/caddy/teleimg-mtproto-bridge.Caddyfile.example`

一套典型部署流程就是：

1. 把 `teleimg-mtproto-bridge` 拷到 `/usr/local/bin/`
2. 把 session 文件放到 `/var/lib/teleimg/`
3. 把环境变量放到 `/etc/teleimg/mtproto-bridge.env`
4. 用 systemd 拉起服务
5. 用 Caddy/Nginx 终止 TLS，并反代到 `127.0.0.1:8788`

### 4. 让 Pages 指向 bridge

在 Cloudflare Pages 环境变量里增加：

- `TG_MT_BRIDGE_URL=https://your-bridge.example.com`
- `TG_MT_BRIDGE_SECRET=replace_with_long_random_secret`

之后行为会变成：

- `getFile` 正常：继续走原来的 Bot API 文件链路。
- `getFile` 返回 `file is too big`：改走短时效签名的 Rust MTProto bridge 下载链路。

## Workers Free plan 版 MTProto bridge（实验态）

如果你不想依赖 VPS 上的付费网络入口，而是希望尽量待在 **Workers Free plan** 能力边界内，仓库里现在还有一个独立子项目：

- `workers-mtproto-bridge/`

它的设计基于：

- Worker HTTP 入口
- 一个 SQLite-backed Durable Object
- outbound TCP sockets
- 一个 GramJS `StringSession` secret

常用命令：

```bash
npm run mtproto:worker:check
npm run mtproto:worker:dev
npm run mtproto:worker:deploy -- --dry-run
```

部署前先看 `workers-mtproto-bridge/README.md`。

## WebDAV（Linux 优先的 MVP）

现在项目已经有一个可用的 `/dav/*` WebDAV 门面，优先面向 Linux 客户端。

当前已支持：

- `OPTIONS`
- `PROPFIND`
- `GET`
- `HEAD`
- `PUT`
- `DELETE`
- `MKCOL`
- `MOVE`
- `COPY`

实现说明：

- 文件内容仍然落在现有 Telegram / bridge / KV 体系里
- WebDAV 只是协议门面，不是另一套独立存储
- 目录采用“虚拟目录”模型
- `/dav/` 根目录会自动投影现有 TeleImg 文件，不需要先用 DAV 重传一遍历史文件

### Linux 快速试用

先确保你已经配置了站点的 Basic Auth，然后可以直接用支持 WebDAV 的客户端挂载。

例如先用 `cadaver` 验证：

```bash
cadaver https://img.vicco.eu.org/dav/
```

或者用 `davfs2` 挂载：

```bash
sudo mkdir -p /mnt/teleimg
sudo mount -t davfs https://img.vicco.eu.org/dav/ /mnt/teleimg
```

如果你不想挂载后目录归 `root`，可以考虑配合 `uid` / `gid` 选项或 `davfs2` 本地配置来挂到当前用户。

认证时使用：

- 用户名：`BASIC_USER`
- 密码：`BASIC_PASS`

### 当前限制

- 这是 Linux 优先的 MVP，不追求 Finder / Windows Explorer 的原生兼容怪癖
- 目前是单 Range 支持，不是 multi-range
