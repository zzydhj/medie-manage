import type { APIRoute } from 'astro';
import { createOrg, listOrgs } from '../../../lib/db';
import { uniqueSlug } from '../../../lib/slug';
import { err, getEnv, isResponse, json, requireSuperAdmin } from '../../../lib/api';

// 列出全部公司(仅超级管理员)
export const GET: APIRoute = async (context) => {
  const guard = requireSuperAdmin(context.locals);
  if (isResponse(guard)) return guard;
  const env = getEnv(context.locals);
  return json({ orgs: await listOrgs(env.DB) });
};

// 创建公司(仅超级管理员)
export const POST: APIRoute = async (context) => {
  const guard = requireSuperAdmin(context.locals);
  if (isResponse(guard)) return guard;
  const env = getEnv(context.locals);

  let body: { name?: string; slug?: string };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  const name = (body.name ?? '').trim();
  if (!name) return err('公司名称不能为空', 400);

  // slug 唯一性:冲突则追加时间戳
  const existing = await listOrgs(env.DB);
  const slug = uniqueSlug(body.slug ?? name, new Set(existing.map((o) => o.slug)));

  const org = await createOrg(env.DB, name, slug);
  return json({ org }, 201);
};
