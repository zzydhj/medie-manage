import type { APIRoute } from 'astro';
import { createOrg, createUser, getUserByUsername, listOrgs, setOrgExpiry } from '../../../lib/db';
import { uniqueSlug } from '../../../lib/slug';
import { generateSalt, hashPassword, sessionCookie, signToken } from '../../../lib/auth';
import { err, getEnv, json } from '../../../lib/api';
import { SITE } from '../../../lib/site';

// 自助开通:公开接口,一次创建「公司 + 公司管理员」并直接签发登录态。
// 路由中间件已把 /api/auth/register 列入放行名单(未登录可调、到期公司也不拦)。
// 新公司带 TRIAL_DAYS 天试用到期,到期后其行为与超管手动设的到期公司一致
// (登录可用但 /api 全部 403),由超管续费或用户联系开通。

/** 免费试用天数(取自站点配置,与首页/注册页同源,不会改漏) */
const TRIAL_DAYS = SITE.trialDays;

/** 试用到期时间戳:东八区「今天 23:59:59」再往后推 TRIAL_DAYS 天。
 *  Workers 运行时为 UTC,这里显式按 +08:00 取日末,与后台手动设到期(当日末)语义对齐。 */
function trialExpiryTs(nowMs = Date.now()): number {
    const CN_OFFSET = 8 * 3600;
    const nowSec = Math.floor(nowMs / 1000);
    const endOfTodayCn = Math.floor((nowSec + CN_OFFSET) / 86400) * 86400 + 86399 - CN_OFFSET;
    return endOfTodayCn + TRIAL_DAYS * 86400;
}

// 尽力而为的注册限流:按 IP 滑动窗口。Workers 的模块作用域只在单个 isolate 内共享,
// 跨实例不保证生效,只作为挡朴素脚本的第一道闸;要真防刷请上 Turnstile / WAF 规则。
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();
function tooMany(ip: string): boolean {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) {
        // 防止内存被无限撑大:窗口内已无记录的键直接清掉
        for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    }
    return recent.length > MAX_PER_WINDOW;
}

export const POST: APIRoute = async (context) => {
    // 收口开关:站点配置关闭自助注册时直接拒绝,连请求体都不解析
    if (!SITE.openRegistration) return err('自助开通暂未开放,请联系网站管理员', 503);

    const env = getEnv(context.locals);

    let body: { orgName?: string; username?: string; password?: string; website?: string };
    try {
        body = await context.request.json();
    } catch {
        return err('请求体格式错误', 400);
    }

    // 蜜罐:表单里的隐藏字段,真人看不到也不会填;填了说明是机器人 → 假装成功,不落库
    if (body.website) return json({ ok: true, trialDays: TRIAL_DAYS });

    const ip = context.clientAddress || context.request.headers.get('cf-connecting-ip') || 'unknown';
    if (tooMany(ip)) return err('注册过于频繁,请稍后再试', 429);

    const orgName = (body.orgName ?? '').trim();
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';

    if (orgName.length < 2 || orgName.length > 40) return err('公司名称需 2-40 个字符', 400);
    if (!/^[\w\u4e00-\u9fa5]{3,24}$/.test(username))
        return err('用户名需 3-24 位,仅限字母、数字、下划线或中文', 400);
    if (password.length < 6 || password.length > 72) return err('密码需 6-72 位', 400);

    // 用户名全局唯一(登录页不分公司),已占用直接提示
    if (await getUserByUsername(env.DB, username)) return err('该用户名已被占用', 409);

    const takenSlugs = new Set((await listOrgs(env.DB)).map((o) => o.slug));
    const org = await createOrg(env.DB, orgName, uniqueSlug(orgName, takenSlugs));

    const expiresAt = trialExpiryTs();
    await setOrgExpiry(env.DB, org.id, expiresAt);

    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    const userId = await createUser(env.DB, {
        orgId: org.id,
        username,
        passwordHash,
        salt,
        role: 'admin', // 注册者即该公司管理员,可自建菜单/上传/管用户
    });

    // 直接签发登录态,注册完即进后台,省一次登录
    const token = await signToken(
        { uid: userId, username, role: 'admin', orgId: org.id },
        env.SESSION_SECRET,
    );

    const res = json(
        {
            ok: true,
            user: { id: userId, username, role: 'admin', orgId: org.id },
            org: { id: org.id, name: org.name },
            expiresAt,
            trialDays: TRIAL_DAYS,
        },
        201,
    );
    res.headers.append('Set-Cookie', sessionCookie(token));
    return res;
};
