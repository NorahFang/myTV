'use client';

/**
 * 弹幕客户端：对接 LogVar 系 danmu_api（兼容弹弹play 接口规范）。
 *
 * 数据链路：
 * 1. POST /api/v2/match                     —— 用「剧名 SxxExx」自动匹配集
 * 2. GET  /api/v2/search/anime?keyword=xxx  —— 兜底：关键字搜索 → 选番剧 → 按集数取 episodeId
 * 3. GET  /api/v2/comment/:episodeId?format=json —— 拉取弹幕（dandanplay JSON 格式）
 *
 * 输出为 artplayer-plugin-danmuku 的弹幕格式：
 *   { time: 秒, mode: 0滚动/1顶部/2底部, color: '#RRGGBB', text }
 */

export interface DanmuComment {
  /** 出现时间（秒） */
  time: number;
  /** 0 滚动 / 1 顶部 / 2 底部 */
  mode: 0 | 1 | 2;
  /** '#RRGGBB' */
  color: string;
  text: string;
}

/**
 * 弹幕服务地址：默认走同源代理 /api/danmu（转发规则见 next.config.ts），
 * 由 Next 服务端转发到 danmu_api 并拼接 TOKEN，浏览器侧无需关心跨域/证书/token。
 * 如需直连（该服务已配好有效 HTTPS 证书时），设置 NEXT_PUBLIC_DANMU_BASE 为完整域名。
 */
const DANMU_BASE = process.env.NEXT_PUBLIC_DANMU_BASE || '/api/danmu';

/**
 * 仅当直连外部地址时才在浏览器侧拼 token（同源代理模式下 token 由服务端注入）。
 * danmu_api 只支持 URL 路径前缀方式传 token：https://域名/{TOKEN}/api/v2/...
 */
const DANMU_TOKEN = process.env.NEXT_PUBLIC_DANMU_TOKEN || '';

/** 拼接弹幕 API 地址：同源代理直接返回相对路径，直连时按需带上 token 前缀 */
function danmuUrl(path: string): string {
  if (DANMU_BASE.startsWith('/')) return `${DANMU_BASE}${path}`;
  return DANMU_TOKEN ? `${DANMU_BASE}/${DANMU_TOKEN}${path}` : `${DANMU_BASE}${path}`;
}

/** 弹幕内存缓存：按「剧名#集数」缓存，避免触发 comment 接口限流（默认 1 分钟 3 次/IP） */
const commentCache = new Map<string, DanmuComment[]>();

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 去掉标题中的集数尾巴（「第X集」「S01E02」等），只留剧名用于弹幕匹配 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*第\s*\d+\s*[集期话回].*$/, '')
    .replace(/\s*[Ss]\d+\s*[Ee]\d+.*$/, '')
    .replace(/\s*[-–—|]\s*\d+\s*$/, '')
    .trim();
}

/**
 * dandanplay JSON 弹幕 → artplayer 弹幕
 * 源格式：{ cid, p: "秒,模式,颜色十进制,[来源]", m: "文本" }
 * 模式：1-3 滚动、4 底部、5 顶部
 */
function convertComment(c: { p?: string; m?: string }): DanmuComment | null {
  if (!c?.p || typeof c.m !== 'string' || !c.m.trim()) return null;
  const parts = c.p.split(',');
  const time = parseFloat(parts[0]);
  if (!Number.isFinite(time) || time < 0) return null;
  const modeNum = parseInt(parts[1], 10) || 1;
  const mode: 0 | 1 | 2 = modeNum >= 1 && modeNum <= 3 ? 0 : modeNum === 4 ? 2 : 1;
  const colorNum = parseInt(parts[2], 10) || 16777215;
  return {
    time,
    mode,
    color: `#${colorNum.toString(16).padStart(6, '0')}`,
    text: c.m,
  };
}

/** 自动匹配：POST /api/v2/match，fileName 用「剧名 S01Exx」（danmu_api 支持从该命名解析标题/集数） */
async function matchEpisodeId(
  title: string,
  episode: number,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(danmuUrl('/api/v2/match'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `${title} S01E${pad2(episode)}` }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.isMatched && Array.isArray(data?.matches) && data.matches.length > 0) {
      return data.matches[0].episodeId ?? null;
    }
  } catch {
    /* 网络/限流失败走兜底搜索 */
  }
  return null;
}

/** 兜底：GET /api/v2/search/anime → /api/v2/bangumi/:animeId → 按集数下标取 episodeId */
async function searchEpisodeId(
  title: string,
  episode: number,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(
      danmuUrl(`/api/v2/search/anime?keyword=${encodeURIComponent(title)}`),
      { signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const animes: Array<{ animeId?: number; animeTitle?: string }> = data?.animes ?? [];
    // 优先取标题包含剧名的条目，其次取第一个
    const anime = animes.find((a) => (a.animeTitle || '').includes(title)) ?? animes[0];
    if (!anime?.animeId) return null;

    const detailRes = await fetch(danmuUrl(`/api/v2/bangumi/${anime.animeId}`), { signal });
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();
    const episodes: Array<{ episodeId?: number }> =
      detail?.bangumi?.episodes ?? detail?.episodes ?? [];
    const ep = episodes[episode - 1] ?? episodes[0];
    return ep?.episodeId ?? null;
  } catch {
    return null;
  }
}

/** 获取某剧某集的弹幕列表（已转换为 artplayer 格式） */
export async function fetchDanmuComments(
  title: string,
  episode: number,
  signal?: AbortSignal,
): Promise<DanmuComment[]> {
  const clean = cleanTitle(title) || title;
  const cacheKey = `${clean}#${episode}`;
  const cached = commentCache.get(cacheKey);
  if (cached) return cached;

  const episodeId =
    (await matchEpisodeId(clean, episode, signal)) ??
    (await searchEpisodeId(clean, episode, signal));
  if (!episodeId) return [];

  const res = await fetch(danmuUrl(`/api/v2/comment/${episodeId}?format=json`), { signal });
  if (!res.ok) return [];
  const data = await res.json();
  const comments = (Array.isArray(data?.comments) ? data.comments : [])
    .map(convertComment)
    .filter((c: DanmuComment | null): c is DanmuComment => c !== null);

  if (comments.length > 0) commentCache.set(cacheKey, comments);
  return comments;
}
