import type { APIRoute } from 'astro';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';
import { extFromName, guessType } from '../upload';

// 分片上传(R2 multipart):Cloudflare 边缘层对单个请求体有 100MB 上限(Free 计划),
// 大视频传完 100% 才在边缘被 413 拒收(客户端只能看到 HTTP 413,读不到我们的 JSON)。
// 故超过阈值的文件由客户端切成 ≤10MB 的分片逐片提交,服务端用 R2 multipart 组装。
// 各步无状态:part/complete/abort 都以 resumeMultipartUpload 恢复 init 创建的会话,服务端不存会话表。
const MAX_TOTAL = 5 * 1024 * 1024 * 1024; // 单文件 5GB 上限

export const POST: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const step = context.url.searchParams.get('step');

  // 创建 multipart 会话:生成带公司前缀的 key(与单文件上传同规则,天然隔离)
  if (step === 'init') {
    const body = (await context.request.json().catch(() => null)) as
      | { name?: string; size?: number; mime?: string; kind?: string }
      | null;
    const name = body?.name || '';
    const size = Number(body?.size || 0);
    const mime = body?.mime || 'application/octet-stream';
    if (!name || !size) return err('缺少文件名或大小', 400);
    if (size > MAX_TOTAL) return err('文件超过 5GB 上限', 413);
    if (!guessType(mime, name)) return err('仅支持图片、视频、PDF、Word、Excel 文件', 415);
    const kind = body?.kind === 'thumb' ? 'thumb' : 'main';
    const ext = extFromName(name);
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const key = `org/${orgId}/items/${yyyy}/${mm}/${crypto.randomUUID()}${kind === 'thumb' ? '-thumb' : ''}${ext}`;
    const mpu = await env.R2.createMultipartUpload(key);
    return json({ key, uploadId: mpu.uploadId });
  }

  // 其余步骤:key 必须落在本公司前缀下,防跨org 操作别人的会话
  const key = context.url.searchParams.get('key') || '';
  const uploadId = context.url.searchParams.get('uploadId') || '';
  if (!key.startsWith(`org/${orgId}/`) || !uploadId) return err('无效的上传会话', 400);
  const mpu = env.R2.resumeMultipartUpload(key, uploadId);

  // 上传一个分片:body 为原始字节,返回 etag 供 complete 校验
  if (step === 'part') {
    const partNumber = Number(context.url.searchParams.get('partNumber') || 0);
    if (!partNumber || partNumber < 1 || partNumber > 10000) return err('分片号非法', 400);
    const buf = await context.request.arrayBuffer();
    if (!buf.byteLength) return err('分片为空', 400);
    const part = await mpu.uploadPart(partNumber, buf);
    return json({ partNumber, etag: part.etag });
  }

  // 组装:按分片号升序提交 etag 清单;size 以 R2 head 为准(权威,不信客户端)
  if (step === 'complete') {
    const body = (await context.request.json().catch(() => null)) as
      | { parts?: Array<{ partNumber: number; etag: string }>; name?: string; mime?: string }
      | null;
    const parts = (body?.parts || []).slice().sort((a, b) => a.partNumber - b.partNumber);
    if (!parts.length) return err('缺少分片清单', 400);
    const name = body?.name || '';
    const mime = body?.mime || 'application/octet-stream';
    const type = name ? guessType(mime, name) : null;
    if (!type) return err('仅支持图片、视频、PDF、Word、Excel 文件', 415);
    await mpu.complete(parts);
    const head = await env.R2.head(key);
    return json({
      key,
      url: `/api/file/${key}`,
      type,
      mime,
      size: head?.size ?? 0,
      filename: name,
    });
  }

  // 客户端失败时 best-effort 清理远端分片,不留垃圾会话
  if (step === 'abort') {
    await mpu.abort().catch(() => {});
    return json({ ok: true });
  }

  return err('未知的 step', 400);
};
