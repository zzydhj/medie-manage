import type { APIRoute } from 'astro';
import { getItem, setFavorite } from '../../lib/db';
import { err, getEnv, isResponse, json, requireOrg, requireUser } from '../../lib/api';

// 收藏开关(个人书签,所有登录用户可用):请求体 { itemId, on }
export const POST: APIRoute = async (context) => {
  const user = requireUser(context.locals);
  if (isResponse(user)) return user;
  const scope = await requireOrg(context);
  if (isResponse(scope)) return scope;
  const env = getEnv(context.locals);

  let body: { itemId?: string; on?: boolean };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  if (!body.itemId || typeof body.on !== 'boolean') return err('缺少参数: itemId / on', 400);

  // 校验素材属于当前公司作用域,防止跨租户收藏
  const item = await getItem(env.DB, body.itemId, scope.orgId);
  if (!item) return err('素材不存在', 404);

  await setFavorite(env.DB, user.id, body.itemId, body.on);
  return json({ ok: true });
};
