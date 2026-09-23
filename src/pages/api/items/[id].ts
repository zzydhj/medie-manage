import type { APIRoute } from 'astro';
import { deleteItem, getItem, getMenu, updateItem } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg, requireOrg } from '../../../lib/api';

// 更新卡片:改标题 / 移动到其它菜单 / 回写缩略图(补生成) / 回写时长(灯箱惰性回填)
export const PATCH: APIRoute = async (context) => {
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  let body: { title?: string; menuId?: string; thumbKey?: string; thumbUrl?: string; duration?: number };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  // 仅回写时长 = 灯箱播放存量视频时的惰性回填(补元数据),放宽到公司成员即可;
  // 其余字段(标题/移动/缩略图)仍仅管理员
  const durationOnly = Object.keys(body).length === 1 && body.duration !== undefined;
  const guard = durationOnly ? await requireOrg(context) : await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;

  const item = await getItem(env.DB, id, orgId);
  if (!item) return err('卡片不存在', 404);

  const patch: {
    title?: string;
    menu_id?: string;
    thumb_key?: string;
    thumb_url?: string;
    duration?: number;
  } = {};
  if (body.title !== undefined) {
    const t = body.title.trim();
    if (!t) return err('标题不能为空', 400);
    patch.title = t;
  }
  if (body.menuId !== undefined) {
    const menu = await getMenu(env.DB, body.menuId, orgId);
    if (!menu) return err('目标菜单不存在', 404);
    patch.menu_id = body.menuId;
  }
  // 缩略图回写:两字段必须成对,且 key 必须落在当前公司 R2 前缀下(防跨租户引用)
  if (body.thumbKey !== undefined || body.thumbUrl !== undefined) {
    if (!body.thumbKey || !body.thumbUrl) return err('thumbKey/thumbUrl 必须成对提供', 400);
    if (!body.thumbKey.startsWith(`org/${orgId}/`)) return err('文件不属于当前公司', 403);
    patch.thumb_key = body.thumbKey;
    patch.thumb_url = body.thumbUrl;
  }
  if (body.duration !== undefined) {
    const d = Number(body.duration);
    if (!isFinite(d) || d <= 0 || d > 86400) return err('时长非法', 400);
    patch.duration = Math.round(d * 10) / 10;
  }

  await updateItem(env.DB, id, orgId, patch);
  return json({ ok: true });
};

// 删除卡片(同时清理 R2 上的文件与缩略图)
export const DELETE: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const item = await getItem(env.DB, id, orgId);
  if (!item) return err('卡片不存在', 404);

  // 先删 R2 对象(忽略不存在错误),再删数据库记录
  try {
    if (item.file_key) await env.R2.delete(item.file_key);
    if (item.thumb_key) await env.R2.delete(item.thumb_key);
  } catch {
    // R2 删除失败不阻塞数据库记录清理
  }
  await deleteItem(env.DB, id, orgId);
  return json({ ok: true });
};
