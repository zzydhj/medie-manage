import type { APIRoute } from 'astro';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

/**
 * 批量判重:POST /api/items/dup-check  body { candidates: [{ filename, size }] }
 *   → { dups: ['filename|size', ...] }(命中的原样回传,前端按 key 认领)
 *
 * 上传流水线并发化后,再像原来那样「每个文件问一次」会把 round-trip 放大成 N 次,
 * 手机网络下每次 150~400ms 纯等待;这里让前端把短时间窗内的询问微批合成一次请求。
 *
 * 判重口径与单文件时代完全一致:同公司内「文件名 + 字节数」都相同才算重复
 * ——相机常生成 IMG_0001.jpg 这类同名文件,只比名字会误判。
 */
const MAX_CANDIDATES = 50;

type Candidate = { filename: string; size: number };

/** 只收合法候选:文件名非空 + 字节数为正整数。非法项当「不重复」放过,不连带拖垮同批其余判定 */
function pickValid(list: unknown[]): Candidate[] {
    const out: Candidate[] = [];
    for (const c of list) {
        const filename = (c as Candidate)?.filename;
        const size = Number((c as Candidate)?.size);
        if (typeof filename === 'string' && filename && Number.isInteger(size) && size > 0) {
            out.push({ filename, size });
        }
    }
    return out;
}

export const POST: APIRoute = async (context) => {
    const guard = await requireAdminOrg(context);
    if (isResponse(guard)) return guard;
    const { orgId } = guard;
    const env = getEnv(context.locals);

    let body: { candidates?: unknown };
    try {
        body = await context.request.json();
    } catch {
        return err('请求体格式错误', 400);
    }
    const list = Array.isArray(body.candidates) ? body.candidates : [];
    if (!list.length) return json({ dups: [] });
    if (list.length > MAX_CANDIDATES) return err(`一次最多判重 ${MAX_CANDIDATES} 个文件`, 400);

    const pairs = pickValid(list);
    if (!pairs.length) return json({ dups: [] });

    // 用 OR 条件而不是行值 IN((a,b) IN ((?,?),…)):后者对 SQLite 版本有要求;
    // 批量上限已锁死 50,语句不会膨胀,且全程参数化无注入风险
    const where = pairs.map(() => '(filename = ? AND size = ?)').join(' OR ');
    const args: (string | number)[] = [orgId];
    for (const p of pairs) args.push(p.filename, p.size);
    const { results } = await env.DB
        .prepare(`SELECT filename, size FROM items WHERE org_id = ? AND (${where})`)
        .bind(...args)
        .all<Candidate>();

    return json({ dups: (results ?? []).map((r) => `${r.filename}|${r.size}`) });
};
