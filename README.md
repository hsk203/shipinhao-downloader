# 视频号下载工具站

粘贴微信视频号分享链接（`https://weixin.qq.com/sph/xxxx`），解析后下载 MP4。

## 文件结构

- `index.html`：单页前端（Tailwind CDN），粘贴链接 → 解析 → 显示封面/标题/作者/时长 → 下载按钮。
- `functions/api/parse.js`：Cloudflare Pages Function，`POST /api/parse`，负责解析。

## 部署（Cloudflare Pages）

1. 在 Cloudflare Pages 新建项目，连接本仓库 `hsk203/shipinhao-downloader`。
2. 构建命令留空，输出目录填 `/`（仓库根目录就是网站根目录）。
3. Functions 默认启用，无需额外配置。部署后访问分配的 `*.pages.dev` 域名即可使用。
4. 可选环境变量 `YUANBAO_COOKIE`：在 Pages 项目 Settings → Environment variables 里设置，值为腾讯元宝登录后的 Cookie（`hy_user=...; hy_token=...; hy_source=web`，约 2 个月有效）。不设置则只用公开解析接口。

## 解析路线现状（2026-11-11 实测）

- **公开解析接口** `sph.litao.workers.dev`（`POST /api/fetch_video_profile`，备用 `GET /api/v1/sph/<id>`）：目前返回 HTTP 401 `{"error":"unauthorized"}`，需要凭证，暂时不可用。Function 会先尝试它，失败时如实返回错误。
- **元宝备用路线**：需要 `YUANBAO_COOKIE`。流程是元宝 `get_parse_result` → 视频号 `get_feed_info`。注意：这条纯 HTTP 链路拿到的 CDN token 直接下载会报 `token not exist!`，因此元宝路线只返回视频信息，并在响应里明确提示下载可能失败。
- **完整下载 MP4**：要拿到可直接下载的链接，需要代理服务器方案（例如 Go 工具 `wx_channels_download` 的 `parse_sph` 接口），本站 v1 不包含这一部分。

## 注意

- 仅供下载自己有权保存的视频。
- 不要调用 miuistore 等第三方站点的私有解析接口。
