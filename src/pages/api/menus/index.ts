import type { APIRoute } from 'astro';
import { createMenu, getMenu, listMenus, menuDepth } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

const MAX_DEPTH = 4;

// 创建菜单:{ name, parentId } —— parentId 为空即一级菜单
export const POST: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);

  let body: { name?: string; parentId?: string | null };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  const name = (body.name ?? '').trim();
  if (!name) return err('菜单名称不能为空', 400);

  let parentId: string | null = body.parentId ?? null;
  if (parentId) {
    const parent = await getMenu(env.DB, parentId, orgId);
    if (!parent) return err('父菜单不存在', 404);
    // 校验新节点深度 = 父深度 + 1 ≤ MAX_DEPTH
    const all = await listMenus(env.DB, orgId);
    const parentDepth = menuDepth(all, parentId);
    if (parentDepth + 1 > MAX_DEPTH) {
      return err(`菜单最多支持 ${MAX_DEPTH} 级`, 400);
    }
  }

  const menu = await createMenu(env.DB, orgId, name, parentId);
  return json({ menu }, 201);
};
