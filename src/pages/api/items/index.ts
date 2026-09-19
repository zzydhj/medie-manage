import type { APIRoute } from 'astro';
import { createItem, getMenu } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

// 创建卡片:{ menuId, type, title, fileKey, fileUrl, thumbKey?, thumbUrl?, mime?, size?, filename? }
// 文件须先经 /api/upload 上传到 R2 得到 key/url
export const POST: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);

  let body: {
    menuId?: string;
    type?: string;
    title?: string;
    fileKey?: string;
    fileUrl?: string;
    thumbKey?: string | null;
    thumbUrl?: string | null;
    mime?: string | null;
    size?: number | null;
    filename?: string | null;
  };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const menuId = body.menuId;
  const type = body.type;
  const title = (body.title ?? '').trim();
  const fileKey = body.fileKey;
  const fileUrl = body.fileUrl;

  if (!menuId) return err('缺少 menuId', 400);
  const VALID_TYPES = ['image', 'video', 'pdf', 'word', 'excel'] as const;
  if (!type || !(VALID_TYPES as readonly string[]).includes(type)) {
    return err('type 必须是 image/video/pdf/word/excel', 400);
  }
  if (!title) return err('标题不能为空', 400);
  if (!fileKey || !fileUrl) return err('缺少文件信息(fileKey/fileUrl)', 400);

  // 校验菜单属于当前公司
  const menu = await getMenu(env.DB, menuId, orgId);
  if (!menu) return err('目标菜单不存在', 404);

  // 安全校验:file_key 必须落在当前公司的 R2 前缀下,防止跨租户引用
  if (!fileKey.startsWith(`org/${orgId}/`)) {
    return err('文件不属于当前公司', 403);
  }

  const id = await createItem(env.DB, {
    orgId,
    menu_id: menuId,
    type: type as 'image' | 'video' | 'pdf' | 'word' | 'excel',
    title,
    file_key: fileKey,
    file_url: fileUrl,
    thumb_key: body.thumbKey ?? null,
    thumb_url: body.thumbUrl ?? null,
    mime: body.mime ?? null,
    size: body.size ?? null,
    filename: body.filename ?? null,
  });

  return json({ item: { id } }, 201);
};
