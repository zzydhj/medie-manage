import type { APIRoute } from 'astro';
import { deleteOrg, getOrg } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireSuperAdmin } from '../../../lib/api';

// 重命名公司(仅超级管理员)
export const PATCH: APIRoute = async (context) => {
  const guard = requireSuperAdmin(context.locals);
  if (isResponse(guard)) return guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  let body: { name?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  const name = (body.name ?? '').trim();
  if (!name) return err('公司名称不能为空', 400);

  const org = await getOrg(env.DB, id);
  if (!org) return err('公司不存在', 404);

  await env.DB.prepare('UPDATE organizations SET name = ? WHERE id = ?').bind(name, id).run();
  return json({ org: { ...org, name } });
};

// 删除公司(仅超级管理员)—— 级联删除该公司所有菜单/卡片/用户
export const DELETE: APIRoute = async (context) => {
  const guard = requireSuperAdmin(context.locals);
  if (isResponse(guard)) return guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const org = await getOrg(env.DB, id);
  if (!org) return err('公司不存在', 404);

  await deleteOrg(env.DB, id);
  return json({ ok: true });
};
