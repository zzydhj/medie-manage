import type { APIRoute } from 'astro';
import { deleteMenu, getMenu, renameMenu } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

// 重命名菜单
export const PATCH: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const menu = await getMenu(env.DB, id, orgId);
  if (!menu) return err('菜单不存在', 404);

  let body: { name?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  const name = (body.name ?? '').trim();
  if (!name) return err('菜单名称不能为空', 400);

  await renameMenu(env.DB, id, orgId, name);
  return json({ ok: true, menu: { ...menu, name } });
};

// 删除菜单(级联删除子菜单与其下卡片)
export const DELETE: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const menu = await getMenu(env.DB, id, orgId);
  if (!menu) return err('菜单不存在', 404);

  await deleteMenu(env.DB, id, orgId);
  return json({ ok: true });
};
