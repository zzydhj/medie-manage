// API 公共辅助:统一 JSON 响应、鉴权守卫、公司作用域解析。
import type { APIContext } from 'astro';
import { getOrg } from './db';
import { canEdit, resolveOrgScope } from './tenant';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function getEnv(locals: App.Locals): Env {
  return locals.runtime.env as Env;
}

/** 要求已登录,返回用户;否则 null */
export function getUser(locals: App.Locals): SessionUser | null {
  return locals.user ?? null;
}

/** 要求已登录 */
export function requireUser(locals: App.Locals): SessionUser | Response {
  const u = locals.user;
  if (!u) return err('未登录', 401);
  return u;
}

/** 要求管理员(超级管理员或公司管理员) */
export function requireAdmin(locals: App.Locals): SessionUser | Response {
  const u = locals.user;
  if (!u) return err('未登录', 401);
  if (!canEdit(u)) return err('无权限:仅管理员可操作', 403);
  return u;
}

/** 要求超级管理员 */
export function requireSuperAdmin(locals: App.Locals): SessionUser | Response {
  const u = locals.user;
  if (!u) return err('未登录', 401);
  if (u.role !== 'superadmin') return err('无权限:仅超级管理员可操作', 403);
  return u;
}

function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}

/**
 * 解析当前请求的公司作用域(带校验)。
 * 返回 { orgId } 或一个错误 Response。
 */
export async function requireOrg(
  context: APIContext,
): Promise<{ orgId: string } | Response> {
  const { locals, request } = context;
  const env = getEnv(locals);
  const user = locals.user;
  if (!user) return err('未登录', 401);
  const res = await resolveOrgScope(user, request, async (id) => !!(await getOrg(env.DB, id)));
  if (res.error) return err(res.error.message, res.error.status);
  if (!res.orgId) return err('无法确定公司作用域', 400);
  return { orgId: res.orgId };
}

/** 组合守卫:必须是管理员,且能解析出公司作用域 */
export async function requireAdminOrg(
  context: APIContext,
): Promise<{ orgId: string; user: SessionUser } | Response> {
  const admin = requireAdmin(context.locals);
  if (isResponse(admin)) return admin;
  const org = await requireOrg(context);
  if (isResponse(org)) return org;
  return { orgId: org.orgId, user: admin };
}

export { isResponse };
