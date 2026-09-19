import type { APIRoute } from 'astro';
import { createUser, getUserByUsername, listUsers } from '../../../lib/db';
import { generateSalt, hashPassword } from '../../../lib/auth';
import { err, getEnv, isResponse, json, requireOrg } from '../../../lib/api';

// 列出用户:超级管理员可看指定公司(或全部);公司管理员看本公司
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) return err('未登录', 401);
  const env = getEnv(context.locals);

  if (user.role === 'superadmin') {
    const orgId = new URL(context.request.url).searchParams.get('orgId');
    const users = await listUsers(env.DB, orgId); // orgId 为 null 时返回全部
    return json({ users: users.map(publicUser) });
  }
  if (user.role === 'admin' && user.orgId) {
    const users = await listUsers(env.DB, user.orgId);
    return json({ users: users.map(publicUser) });
  }
  return err('无权限', 403);
};

// 创建用户:超级管理员可对任意公司建用户;公司管理员仅能对本公司建 user
export const POST: APIRoute = async (context) => {
  const actor = context.locals.user;
  if (!actor) return err('未登录', 401);
  const env = getEnv(context.locals);

  let body: { username?: string; password?: string; role?: string; orgId?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) return err('用户名和密码不能为空', 400);
  if (password.length < 6) return err('密码至少 6 位', 400);

  let role: SessionUser['role'] = 'user';
  let orgId: string | null = null;

  if (actor.role === 'superadmin') {
    // 超级管理员:可创建 superadmin / admin / user
    if (body.role === 'superadmin' || body.role === 'admin' || body.role === 'user') {
      role = body.role;
    }
    if (role === 'superadmin') {
      orgId = null;
    } else {
      // 非超级管理员账号必须归属某公司
      const scope = await requireOrg(context);
      if (isResponse(scope)) return scope;
      orgId = body.orgId ? body.orgId : scope.orgId;
      // 校验公司存在
      const org = await env.DB.prepare('SELECT id FROM organizations WHERE id = ?')
        .bind(orgId)
        .first();
      if (!org) return err('目标公司不存在', 404);
    }
  } else if (actor.role === 'admin') {
    // 公司管理员:只能建本公司的普通用户
    role = 'user';
    orgId = actor.orgId;
    if (!orgId) return err('账号未绑定公司', 403);
  } else {
    return err('无权限', 403);
  }

  // 用户名全局唯一
  const existing = await getUserByUsername(env.DB, username);
  if (existing) return err('用户名已存在', 409);

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const id = await createUser(env.DB, { orgId, username, passwordHash, salt, role });

  return json({ user: { id, username, role, orgId } }, 201);
};

function publicUser(u: {
  id: string;
  username: string;
  role: string;
  org_id: string | null;
}) {
  return { id: u.id, username: u.username, role: u.role, orgId: u.org_id };
}
