/**
 * Cloudflare Pages Function: POST /api/parse
 *
 * 解析微信视频号分享链接，返回视频信息与可下载直链。
 * 路线 1（优先）：公开解析接口 sph.litao.workers.dev
 * 路线 2（备用，仅当设置了 YUANBAO_COOKIE 环境变量）：腾讯元宝解析 + 视频号 Feed 接口。
 *   注意：元宝路线拿到的 CDN token 直接下载会报 "token not exist!"，
 *   因此该路线只返回元数据，并在响应里明确提示下载可能失败。
 * 响应里绝不包含任何密钥。
 */

const LITAO_BASE = "https://sph.litao.workers.dev";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function pickVideoUrl(feedInfo) {
  if (!feedInfo) return "";
  const h264 = (feedInfo.h264VideoInfo || {}).videoUrl || "";
  if (h264) return h264;
  const h265 = (feedInfo.h265VideoInfo || {}).videoUrl || "";
  if (h265) return h265;
  return feedInfo.videoUrl || "";
}

function pickDuration(feedInfo) {
  if (!feedInfo) return "";
  const v = feedInfo.duration ?? feedInfo.videoDuration ?? feedInfo.video_duration ?? "";
  if (typeof v === "number" && v > 0) {
    const m = Math.floor(v / 60);
    const s = Math.round(v % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return typeof v === "string" && v ? v : "";
}

function normalizeLitao(data) {
  // litao 返回形如 { data: { feedInfo, authorInfo } }，也可能直接带 error 字段
  if (!data || typeof data !== "object") return null;
  if (data.error) return { error: String(data.error) };
  const inner = data.data || data;
  const feedInfo = inner.feedInfo || null;
  const authorInfo = inner.authorInfo || {};
  if (!feedInfo) return null;
  const videoUrl = pickVideoUrl(feedInfo);
  if (!videoUrl) return null;
  return {
    ok: true,
    title: feedInfo.description || "",
    author: authorInfo.nickname || "",
    cover: feedInfo.coverUrl || "",
    videoUrl,
    mediaType: feedInfo.mediaType ?? null,
    duration: pickDuration(feedInfo),
  };
}

async function tryLitao(shareUrl, id) {
  // 主路线：POST /api/fetch_video_profile
  try {
    const resp = await fetch(`${LITAO_BASE}/api/fetch_video_profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: shareUrl }),
      signal: AbortSignal.timeout(20000),
    });
    if (resp.status === 401) {
      return { ok: false, error: "解析接口需要验证（401），暂时不可用" };
    }
    if (resp.ok) {
      const data = await resp.json();
      const norm = normalizeLitao(data);
      if (norm) return { ok: true, data: norm };
      if (data && data.errCode) {
        return { ok: false, error: `解析接口返回错误（errCode=${data.errCode}）` };
      }
      return { ok: false, error: "解析接口没有返回视频地址" };
    }
    // 备用：GET /api/v1/sph/<id>
    const resp2 = await fetch(`${LITAO_BASE}/api/v1/sph/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (resp2.status === 401) {
      return { ok: false, error: "解析接口需要验证（401），暂时不可用" };
    }
    if (resp2.ok) {
      const data = await resp2.json();
      const norm = normalizeLitao(data);
      if (norm) return { ok: true, data: norm };
      return { ok: false, error: "解析接口没有返回视频地址" };
    }
    return { ok: false, error: `解析接口请求失败（HTTP ${resp.status}）` };
  } catch (e) {
    return { ok: false, error: "解析接口请求超时或网络异常" };
  }
}

function makeRid() {
  const ts = Math.floor(Date.now() / 1000).toString(16);
  const rand = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `${ts}-${rand}`;
}

async function tryYuanbao(shareUrl, cookie) {
  try {
    // 第一步：元宝解析，拿到 playable_url（含 token 与 eid）
    const ybResp = await fetch("https://yuanbao.tencent.com/api/weixin/get_parse_result", {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "content-type": "application/json",
        origin: "https://yuanbao.tencent.com",
        referer: "https://yuanbao.tencent.com/chat/naQivTmsDa/",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        cookie,
        "x-language": "zh-CN",
        "x-platform": "mac",
        "x-source": "web",
        "x-webversion": "2.69.0",
      },
      body: JSON.stringify({ type: "video_channel_url", url: shareUrl, scene: 1 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!ybResp.ok) return { ok: false, error: `元宝接口请求失败（HTTP ${ybResp.status}）` };
    const yb = await ybResp.json();
    if (yb.code !== 0) {
      return { ok: false, error: `元宝解析失败（code=${yb.code}）：${yb.msg || "Cookie 可能已失效，请重新登录元宝获取"}` };
    }
    const playable = (yb.data && yb.data.playable_url) || "";
    const exportId = (yb.data && yb.data.wx_export_id) || "";
    if (!playable) return { ok: false, error: "元宝没有返回可播放地址" };
    const u = new URL(playable);
    const token = u.searchParams.get("token") || "";
    const eid = u.searchParams.get("eid") || exportId;
    if (!token || !eid) return { ok: false, error: "元宝返回的地址缺少 token 或 eid" };

    // 第二步：视频号 Feed 接口拿完整信息
    const rid = makeRid();
    const feedResp = await fetch(
      `https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info?_rid=${rid}&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Ffinder-preview%2Fpages%2Ffeed`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Content-Type": "application/json",
          Origin: "https://channels.weixin.qq.com",
          Referer: `https://channels.weixin.qq.com/finder-preview/pages/feed?entry_card_type=48&comment_scene=39&appid=0&token=${token}&entry_scene=0&eid=${eid}`,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({ baseReq: { generalToken: token }, exportId: eid }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!feedResp.ok) return { ok: false, error: `视频号接口请求失败（HTTP ${feedResp.status}）` };
    const feed = await feedResp.json();
    if (feed.errCode !== 0) {
      return { ok: false, error: `视频号接口返回错误（errCode=${feed.errCode}）` };
    }
    const feedInfo = ((feed.data || {}).feedInfo) || {};
    const authorInfo = ((feed.data || {}).authorInfo) || {};
    const videoUrl = pickVideoUrl(feedInfo);
    if (!videoUrl) return { ok: false, error: "元宝路线没有拿到视频地址" };
    return {
      ok: true,
      data: {
        ok: true,
        title: feedInfo.description || (yb.data && yb.data.desc) || "",
        author: authorInfo.nickname || (yb.data && yb.data.author) || "",
        cover: feedInfo.coverUrl || (yb.data && yb.data.cover_url) || "",
        videoUrl,
        mediaType: feedInfo.mediaType ?? null,
        duration: pickDuration(feedInfo),
        downloadMayFail: true,
        warning:
          "提示：这是元宝备用路线拿到的信息，直接点下载可能失败（CDN token 失效问题）。完整下载需要代理服务器配合。",
      },
    };
  } catch (e) {
    return { ok: false, error: "元宝路线请求超时或网络异常" };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求格式不正确，请传入 JSON {url}" }, 400);
  }
  const url = String((body && body.url) || "").trim();
  const m = url.match(/^https?:\/\/weixin\.qq\.com\/sph\/([A-Za-z0-9_-]+)/);
  if (!m) {
    return json(
      { ok: false, error: "链接格式不对，请粘贴微信视频号分享链接，如 https://weixin.qq.com/sph/xxxx" },
      400,
    );
  }
  const id = m[1];
  const shareUrl = `https://weixin.qq.com/sph/${id}`;

  const litao = await tryLitao(shareUrl, id);
  if (litao.ok) return json(litao.data);

  if (env.YUANBAO_COOKIE) {
    const yb = await tryYuanbao(shareUrl, env.YUANBAO_COOKIE);
    if (yb.ok) return json(yb.data);
    return json(
      { ok: false, error: `公开解析接口不可用（${litao.error}）；元宝备用路线也失败：${yb.error}` },
      502,
    );
  }
  return json({ ok: false, error: `解析失败：${litao.error}` }, 502);
}
