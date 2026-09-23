import { defineMiddleware } from 'astro:middleware';
import { readSessionCookie, verifyToken } from './lib/auth';
import { getOrg, orgExpired } from './lib/db';

// 全站中间件:每个请求都先解析登录态,并计算当前公司作用域。
export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, request, url } = context;
  const env = locals.runtime?.env as Env | undefined;

  locals.user = null;
  locals.currentOrgId = null;
  // 会话因公司会员到期被作废:跳转登录页时带上标记,直接展示续费提示
  let expiredKick = false;

  if (env?.DB && env?.SESSION_SECRET) {
    const token = readSessionCookie(request);
    if (token) {
      const payload = await verifyToken(token, env.SESSION_SECRET);
      if (payload) {
        // 普通用户/公司管理员:公司到期则会话立即作废(超管不受限,需保留续费管理入口)
        if (payload.role !== 'superadmin' && payload.orgId) {
          const org = await getOrg(env.DB, payload.orgId);
          if (org && orgExpired(org.expires_at)) expiredKick = true;
        }
        if (!expiredKick) {
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
  }

  const isApi = url.pathname.startsWith('/api/');
  const isLogin = url.pathname === '/login';

  // 页面级登录拦截:未登录访问非登录页 → 跳转登录页
  if (!isApi && !isLogin && !locals.user) {
    return context.redirect(expiredKick ? '/login?expired=1' : '/login');
  }

  // 已登录用户访问登录页 → 回主页
  if (isLogin && locals.user) {
    return context.redirect('/');
  }

  return next();
});
