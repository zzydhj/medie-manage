import type { APIRoute } from 'astro';
import { deleteUser, getUserById } from '../../../lib/db';
import { err, getEnv, json } from '../../../lib/api';

// 删除用户:超级管理员可删任意用户(但不能删自己);公司管理员可删本公司普通用户
export const DELETE: APIRoute = async (context) => {
  const actor = context.locals.user;
  if (!actor) return err('未登录', 401);
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const target = await getUserById(env.DB, id);
  if (!target) return err('用户不存在', 404);
  if (target.id === actor.id) return err('不能删除自己', 400);

  if (actor.role === 'superadmin') {
    await deleteUser(env.DB, id);
    return json({ ok: true });
  }
  if (actor.role === 'admin') {
    if (target.org_id !== actor.orgId) return err('无权删除其它公司用户', 403);
    if (target.role !== 'user') return err('无权删除管理员账号', 403);
    await deleteUser(env.DB, id);
    return json({ ok: true });
  }
  return err('无权限', 403);
};
