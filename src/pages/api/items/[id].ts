import type { APIRoute } from 'astro';
import { deleteItem, getItem, getMenu, updateItem } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

// 更新卡片:改标题 / 移动到其它菜单
export const PATCH: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const item = await getItem(env.DB, id, orgId);
  if (!item) return err('卡片不存在', 404);

  let body: { title?: string; menuId?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const patch: { title?: string; menu_id?: string } = {};
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
