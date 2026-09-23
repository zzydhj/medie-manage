import type { APIRoute } from 'astro';
import { getOrg, getUserByUsername, orgExpired } from '../../../lib/db';
import { sessionCookie, signToken, verifyPassword } from '../../../lib/auth';
import { err, getEnv, json } from '../../../lib/api';

export const POST: APIRoute = async (context) => {
  const env = getEnv(context.locals);
  let body: { username?: string; password?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) return err('用户名和密码不能为空', 400);

  const user = await getUserByUsername(env.DB, username);
  // 用户不存在或密码错误,统一返回同一提示,避免用户名枚举
  if (!user) return err('用户名或密码错误', 401);
  const ok = await verifyPassword(password, user.salt, user.password_hash);
  if (!ok) return err('用户名或密码错误', 401);

  // 会员到期校验:账号所属公司到期则拒登(超管 org_id 为 NULL 不受限)
  if (user.org_id) {
    const org = await getOrg(env.DB, user.org_id);
    if (org && orgExpired(org.expires_at)) return err('会员已到期,请续费后使用', 403);
  }

  const token = await signToken(
    {
      uid: user.id,
      username: user.username,
      role: user.role,
      orgId: user.org_id,
    },
    env.SESSION_SECRET,
  );

  const res = json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role, orgId: user.org_id },
  });
  res.headers.append('Set-Cookie', sessionCookie(token));
  return res;
};
