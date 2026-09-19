import type { APIRoute } from 'astro';
import { setUserGridCols } from '../../../lib/db';
import { err, getEnv, json } from '../../../lib/api';

// 保存当前登录用户的账户级 UI 偏好(每行列数)。
// 存于 users.grid_cols,跨设备/跨浏览器跟随账户;下次登录由 /api/me 带回。
export const PATCH: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) return err('未登录', 401);
  const env = getEnv(context.locals);

  let body: { gridCols?: unknown };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const cols = body.gridCols;
  if (cols === null) {
    await setUserGridCols(env.DB, user.id, null);
    return json({ ok: true });
  }
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 2 || cols > 24) {
    return err('gridCols 必须是 2~24 的整数', 400);
  }

  await setUserGridCols(env.DB, user.id, cols);
  return json({ ok: true });
};
