import { NextRequest, NextResponse } from 'next/server';

/**
 * 弹幕 API 同源代理：浏览器请求 /api/danmu/api/v2/xxx，由服务端转发到 danmu_api。
 *
 * 这样做可以同时规避三类问题：
 * 1. 跨域（CORS）——浏览器只访问同源地址；
 * 2. 混合内容——myTV 是 https，弹幕服务只有 http 时浏览器会拦截；
 * 3. 自定义域名 SSL 证书未签发的证书错误。
 *
 * danmu_api 的 TOKEN 只支持 URL 路径前缀传参（/{TOKEN}/api/v2/...），故在此拼接。
 * 可通过环境变量覆盖：DANMU_API_URL、DANMU_API_TOKEN。
 */

const DANMU_API_URL = process.env.DANMU_API_URL || 'http://mydm369.happyweekend.top';
const DANMU_API_TOKEN = process.env.DANMU_API_TOKEN || '312614';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 弹幕源聚合首拉可能需要十几秒（18585 条弹幕约 19s），放宽函数超时避免被 Vercel 掐断
export const maxDuration = 60;

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const prefix = DANMU_API_TOKEN ? `/${DANMU_API_TOKEN}` : '';
  const target = new URL(`${DANMU_API_URL}${prefix}/${(path ?? []).join('/')}`);
  target.search = req.nextUrl.search;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    });

    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      { errorCode: 502, success: false, errorMessage: `弹幕服务不可用: ${message}` },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
