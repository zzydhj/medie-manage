import type { APIRoute } from 'astro';
import { listOrgs, getOrg, getUserById, orgExpired } from '../../lib/db';
import { getEnv, json } from '../../lib/api';

// 返回当前登录用户信息;超级管理员额外返回可切换的公司列表及其默认作用域
export const GET: APIRoute = async (context) => {
  const env = getEnv(context.locals);
  const user = context.locals.user;
  if (!user) return json({ user: null }, 401);

  // 读取账户级 UI 偏好(每行列数);会话令牌中不含该字段,需回查 users 表
  const row = await getUserById(env.DB, user.id);

  const payload: Record<string, unknown> = {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      orgId: user.orgId,
      gridCols: row?.grid_cols ?? null,
    },
  };

  if (user.role === 'superadmin') {
    const orgs = await listOrgs(env.DB);
    payload.orgs = orgs;
    // 若前端未指定公司,默认选中第一个,便于切换器初始化
    const requested =
      context.request.headers.get('x-org-id') ||
      new URL(context.request.url).searchParams.get('orgId');
    const active = requested && orgs.some((o) => o.id === requested) ? requested : orgs[0]?.id ?? null;
    payload.activeOrgId = active;
    payload.orgExpired = false; // 超管不受会员到期限制
  } else if (user.orgId) {
    const org = await getOrg(env.DB, user.orgId);
    payload.org = org;
    payload.activeOrgId = user.orgId;
    // 会员状态:客户端据此在点功能时弹续费大弹窗(浏览不受影响)
    payload.orgExpired = orgExpired(org?.expires_at);
  }

  return json(payload);
};
