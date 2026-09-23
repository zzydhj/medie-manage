import type { APIRoute } from 'astro';
import { reorderFavorite } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireOrg, requireUser } from '../../../lib/api';

// 收藏拖拽调序(个人顺序,所有登录用户可用,只影响自己):请求体 { itemId, newIndex }
export const PATCH: APIRoute = async (context) => {
  const user = requireUser(context.locals);
  if (isResponse(user)) return user;
  const scope = await requireOrg(context);
  if (isResponse(scope)) return scope;
  const env = getEnv(context.locals);

  let body: { itemId?: string; newIndex?: number };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  if (!body.itemId || typeof body.newIndex !== 'number') return err('缺少参数: itemId / newIndex', 400);

  const ok = await reorderFavorite(env.DB, user.id, scope.orgId, body.itemId, Math.max(0, Math.floor(body.newIndex)));
  if (!ok) return err('该素材不在收藏中', 404);
  return json({ ok: true });
};
