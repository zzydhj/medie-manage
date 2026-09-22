import type { APIRoute } from 'astro';
import { getOrg, getStorageByOrg, listOrgs } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdmin } from '../../../lib/api';

// 存储用量:超级管理员看全部公司(按公司分组),公司管理员只看本公司。
// 用量 = 各素材原文件 size 合计(不含缩略图);仅统计到公司级,不细分到用户。
export const GET: APIRoute = async (context) => {
  const admin = requireAdmin(context.locals);
  if (isResponse(admin)) return admin;
  const env = getEnv(context.locals);

  // 超级管理员:列出全部公司 + 各自用量,按用量降序
  if (admin.role === 'superadmin') {
    const [orgs, usage] = await Promise.all([listOrgs(env.DB), getStorageByOrg(env.DB, null)]);
    const byOrg = new Map(usage.map((u) => [u.org_id, u]));
    const rows = orgs
      .map((o) => ({
        id: o.id,
        name: o.name,
        bytes: byOrg.get(o.id)?.bytes ?? 0,
        count: byOrg.get(o.id)?.count ?? 0,
      }))
      .sort((a, b) => b.bytes - a.bytes);
    const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
    const totalCount = rows.reduce((s, r) => s + r.count, 0);
    return json({ scope: 'all', orgs: rows, totalBytes, totalCount });
  }

  // 公司管理员:仅本公司
  if (!admin.orgId) return err('账号未绑定公司', 403);
  const [org, usage] = await Promise.all([
    getOrg(env.DB, admin.orgId),
    getStorageByOrg(env.DB, admin.orgId),
  ]);
  const u = usage[0];
  const rows = [
    { id: admin.orgId, name: org?.name ?? '本公司', bytes: u?.bytes ?? 0, count: u?.count ?? 0 },
  ];
  return json({ scope: 'org', orgs: rows, totalBytes: rows[0].bytes, totalCount: rows[0].count });
};
