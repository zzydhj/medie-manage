import { defineMiddleware } from 'astro:middleware';
import { readSessionCookie, verifyToken } from './lib/auth';
import { getOrg } from './lib/db';

// 全站中间件:每个请求都先解析登录态,并计算当前公司作用域。
export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, request, url } = context;
  const env = locals.runtime?.env as Env | undefined;

  locals.user = null;
  locals.currentOrgId = null;

  if (env?.DB && env?.SESSION_SECRET) {
    const token = readSessionCookie(request);
    if (token) {
      const payload = await verifyToken(token, env.SESSION_SECRET);
      if (payload) {
        locals.user = {
          id: payload.uid,
          username: payload.username,
          role: payload.role,
          orgId: payload.orgId,
        };
        // 普通用户/公司管理员:作用域即自身公司
        if (payload.role !== 'superadmin') {
          locals.currentOrgId = payload.orgId;
        } else {
          // 超级管理员:从请求头/查询参数解析目标公司(仅用于内容类接口)
          const requested =
            request.headers.get('x-org-id') || url.searchParams.get('orgId');
          if (requested) {
            const org = await getOrg(env.DB, requested);
            if (org) locals.currentOrgId = org.id;
          }
        }
      }
    }
  }

  const isApi = url.pathname.startsWith('/api/');
  const isLogin = url.pathname === '/login';

  // 页面级登录拦截:未登录访问非登录页 → 跳转登录页
  if (!isApi && !isLogin && !locals.user) {
    return context.redirect('/login');
  }

  // 已登录用户访问登录页 → 回主页
  if (isLogin && locals.user) {
    return context.redirect('/');
  }

  return next();
});
