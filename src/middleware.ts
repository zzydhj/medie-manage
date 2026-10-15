import { defineMiddleware } from 'astro:middleware';
import { readSessionCookie, verifyToken } from './lib/auth';
import { getOrg, orgExpired } from './lib/db';

// 公开页:无需登录即可访问(营销首页 + 登录 + 自助注册);后台控制台在 /app,受保护
const PUBLIC_PAGES = new Set(['/', '/login', '/register']);
// 公开接口:登录/登出/注册必须允许未登录调用
const PUBLIC_APIS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/register']);

// 全站中间件:每个请求都先解析登录态,并计算当前公司作用域。
export const onRequest = defineMiddleware(async (context, next) => {
  const { locals, request, url } = context;
  const env = locals.runtime?.env as Env | undefined;

  locals.user = null;
  locals.currentOrgId = null;
  // 公司会员到期:登录与浏览(GET)照常放行,仅写操作由下方兜底拦截
  let expiredOrg = false;

  if (env?.DB && env?.SESSION_SECRET) {
    const token = readSessionCookie(request);
    if (token) {
      const payload = await verifyToken(token, env.SESSION_SECRET);
      if (payload) {
        // 普通用户/公司管理员:按公司到期标记会员状态(超管不受限,需保留续费管理入口)
        if (payload.role !== 'superadmin' && payload.orgId) {
          const org = await getOrg(env.DB, payload.orgId);
          if (org && orgExpired(org.expires_at)) expiredOrg = true;
        }
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
  const isPublicPage = PUBLIC_PAGES.has(url.pathname);

  // 页面级登录拦截:未登录访问后台等受保护页 → 跳转登录页
  if (!isApi && !isPublicPage && !locals.user) {
    return context.redirect('/login');
  }

  // 已登录用户访问根域名 / 登录页 / 注册页 → 直接进后台。
  // 根域名改成官网首页后,这条规则让老客户的书签 / 二维码 / 收藏夹维持“输网址就进后台”的旧行为,
  // 只有未登录的新访客才会看到营销页。
  if (locals.user && (url.pathname === '/' || url.pathname === '/login' || url.pathname === '/register')) {
    return context.redirect('/app');
  }

  // 到期公司兜底:拒发任何数据——/api 全部 403(仅保留 me/登录/注册/登出),
  // 含 /api/file 文件字节:浏览器拿不到数据,右键另存/插件抓包都无从保存;
  // 客户端锁屏+续费大弹窗先拦交互,正常走不到这里
  const allowList = url.pathname === '/api/me' || PUBLIC_APIS.has(url.pathname);
  if (expiredOrg && isApi && !allowList) {
    return new Response(JSON.stringify({ error: '会员已到期,请续费后使用' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  return next();
});
