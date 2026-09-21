import type { APIRoute } from 'astro';
import { err, getEnv } from '../../../lib/api';

// 从 R2 流式返回文件。
// 路径:/api/file/<key>,key 形如 org/{orgId}/items/2026/09/uuid.ext
// 访问控制:登录用户须属于该 key 对应的公司;超级管理员放行。
// ?download=1 → 以附件形式下载(用数据库里的原始文件名)。
export const GET: APIRoute = async (context) => {
  const env = getEnv(context.locals);
  const user = context.locals.user;
  if (!user) return err('未登录', 401);

  const key = context.params.key as string;
  if (!key) return err('缺少文件 key', 400);

  // 解析 key 中的公司前缀做租户校验
  const parts = key.split('/');
  if (parts[0] !== 'org' || !parts[1]) return err('非法文件路径', 400);
  const keyOrgId = parts[1];
  if (user.role !== 'superadmin' && user.orgId !== keyOrgId) {
    return err('无权访问该文件', 403);
  }

  // 手动把 Range 头解析成纯对象(POJO)再传给 R2.get:
  // 本地 miniflare 无法跨边界序列化 Headers 对象("Cannot stringify arbitrary non-POJOs"),
  // 直接把 context.request.headers 传进去会 500。POJO 形式本地/线上都兼容。
  const rangeHeader = context.request.headers.get('range');
  let rangeOpt: { offset: number; length?: number } | { suffix: number } | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (m) {
      const s = m[1];
      const e = m[2];
      if (s === '' && e !== '') {
        rangeOpt = { suffix: parseInt(e, 10) };
      } else if (s !== '') {
        const offset = parseInt(s, 10);
        rangeOpt = e !== '' ? { offset, length: parseInt(e, 10) - offset + 1 } : { offset };
      }
    }
  }

  const obj = rangeOpt ? await env.R2.get(key, { range: rangeOpt }) : await env.R2.get(key);
  if (!obj) return err('文件不存在', 404);

  const headers = new Headers();
  // 不用 obj.writeHttpMetadata(headers):本地 miniflare 下它会跨代理边界序列化 Headers,
  // 触发 "Cannot stringify arbitrary non-POJOs"。改为手动从 httpMetadata 读 contentType。
  const ct = obj.httpMetadata?.contentType;
  if (ct) headers.set('content-type', ct);
  if (obj.httpEtag) headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');

  // 下载模式:补 Content-Disposition,尽量使用数据库中的原始文件名
  const url = new URL(context.request.url);
  if (url.searchParams.get('download') === '1') {
    let filename = parts[parts.length - 1];
    const row = await env.DB.prepare(
      'SELECT title, filename FROM items WHERE file_key = ? OR thumb_key = ? LIMIT 1',
    )
      .bind(key, key)
      .first<{ title: string; filename: string | null }>();
    if (row) filename = row.filename || row.title || filename;
    headers.set(
      'content-disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }

  // 关键:先把 body 读成 ArrayBuffer 再返回。
  // 本地 dev 下 env.R2 是 platformProxy 跨进程代理,obj.body 是代理流(非 POJO),
  // 直接 new Response(obj.body) 会让 miniflare 序列化报
  // "Cannot stringify arbitrary non-POJOs"。arrayBuffer 本地/线上都兼容。
  const body = await obj.arrayBuffer();

  // 命中 Range → 206 部分内容(R2Range 为联合类型,需分别收窄)
  const range = obj.range;
  if (range && rangeHeader) {
    let offset = 0;
    let length = obj.size;
    if ('offset' in range) {
      const r = range as { offset: number; length?: number };
      offset = r.offset;
      length = typeof r.length === 'number' ? r.length : obj.size - offset;
    } else if ('suffix' in range) {
      const r = range as { suffix: number };
      length = r.suffix;
      offset = Math.max(0, obj.size - length);
    }
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(body.byteLength));
    headers.set('cache-control', 'private, max-age=31536000');
    return new Response(body, { status: 206, headers });
  }

  headers.set('content-length', String(body.byteLength));
  // 文件按 key 不可变(uuid 路径、永不覆盖):允许浏览器长期私有缓存,
  // 同设备重复打开大图/缩略图直接命中磁盘缓存,不再重新下载。
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(body, { status: 200, headers });
};
