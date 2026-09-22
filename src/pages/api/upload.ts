import type { APIRoute } from 'astro';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../lib/api';

const MAX_SIZE = 100 * 1024 * 1024; // 100MB 上限

export function extFromName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

type ItemType = 'image' | 'video' | 'pdf' | 'word' | 'excel';

// 按 mime 优先、扩展名兜底识别类型(浏览器对 Office 文件常报通用 mime);分片上传(mp.ts)复用
export function guessType(mime: string, filename: string): ItemType | null {
  const m = (mime || '').toLowerCase();
  const ext = extFromName(filename);
  if (m.startsWith('image/')) return 'image';
  // 苹果 HEIC/HEIF:部分浏览器报 octet-stream,用扩展名兜底归为图片
  if (ext === '.heic' || ext === '.heif') return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    m === 'application/msword' ||
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.doc' ||
    ext === '.docx'
  )
    return 'word';
  if (
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === '.xls' ||
    ext === '.xlsx'
  )
    return 'excel';
  return null;
}

// 上传文件到 R2。表单字段:file(必填)、kind(可选:'main' | 'thumb')
// 返回:{ key, url, type, mime, size, filename }
export const POST: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return err('必须以 multipart/form-data 提交', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return err('缺少文件字段 file', 400);
  if (file.size === 0) return err('文件为空', 400);
  if (file.size > MAX_SIZE) return err('文件超过 100MB 上限', 413);

  const mime = file.type || 'application/octet-stream';
  const type = guessType(mime, file.name);
  if (!type) return err('仅支持图片、视频、PDF、Word、Excel 文件', 415);

  const kind = (form.get('kind') as string) || 'main';
  const ext = extFromName(file.name);
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  // key 一经生成即固定;带公司前缀,天然隔离
  const key = `org/${orgId}/items/${yyyy}/${mm}/${uuid}${kind === 'thumb' ? '-thumb' : ''}${ext}`;

  // 用定长 body(arrayBuffer)而非 file.stream():本地 miniflare/workerd 下
  // R2.put 要求可读流有已知长度,直接传流会抛
  // "Provided readable stream must have a known length"。arrayBuffer 本地/线上都兼容。
  await env.R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });

  return json({
    key,
    url: `/api/file/${key}`,
    type,
    mime,
    size: file.size,
    filename: file.name,
  });
};
