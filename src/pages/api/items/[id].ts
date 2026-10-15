import type { APIRoute } from 'astro';
import { deleteItem, getItem, getMenu, updateItem } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg, requireOrg } from '../../../lib/api';

// 更新卡片:改标题 / 移动到其它菜单 / 回写缩略图(补生成或重建) / 回写时长(灯箱惰性回填)

/**
 * 删除被替换掉的旧缩略图对象。四道闸,任一不过就不删(宁留孤儿,不可误删):
 *  1) 确有旧 key;2) 新旧不同;3) 旧 key 不是本条素材的原图——脚本灌入的数据里
 *     thumb_key 可能等于 file_key,删了就等于删原文件;4) 全库再查一遍,没有任何
 *     行的 file_key / thumb_key 仍指向它(多行共用同一缩略图时不能删)。
 *  调用时机必须在 DB 更新之后:这样任何一步失败只会留下未被引用的孤儿对象,不会让卡片丢图。
 */
async function cleanupReplacedThumb(
  env: Env,
  oldKey: string | null,
  newKey: string,
  fileKey: string,
): Promise<void> {
  if (!oldKey || oldKey === newKey || oldKey === fileKey) return;
  const still = await env.DB
    .prepare('SELECT 1 AS x FROM items WHERE file_key = ? OR thumb_key = ? LIMIT 1')
    .bind(oldKey, oldKey)
    .first();
  if (still) return; // 仍被引用:不删
  try {
    await env.R2.delete(oldKey);
  } catch {
    // 删失败留孤儿:不影响任何显示正确性,可另做孤儿清理
  }
}

export const PATCH: APIRoute = async (context) => {
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  let body: {
    title?: string;
    menuId?: string;
    thumbKey?: string;
    thumbUrl?: string;
    duration?: number;
    /** 显式声明「这是替换缩略图」:成功后顺带清理旧对象。不传则只换指向、不动旧文件 */
    replaceThumb?: boolean;
  };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  // 仅回写时长 = 灯箱播放存量视频时的惰性回填(补元数据),放宽到公司成员即可;
  // 其余字段(标题/移动/缩略图)仍仅管理员
  const durationOnly = Object.keys(body).length === 1 && body.duration !== undefined;
  const guard = durationOnly ? await requireOrg(context) : await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;

  const item = await getItem(env.DB, id, orgId);
  if (!item) return err('卡片不存在', 404);

  const patch: {
    title?: string;
    menu_id?: string;
    thumb_key?: string;
    thumb_url?: string;
    duration?: number;
  } = {};
  if (body.title !== undefined) {
    const t = body.title.trim();
    if (!t) return err('标题不能为空', 400);
    patch.title = t;
  }
  if (body.menuId !== undefined) {
    const menu = await getMenu(env.DB, body.menuId, orgId);
    if (!menu) return err('目标菜单不存在', 404);
    patch.menu_id = body.menuId;
  }
  // 缩略图回写:两字段必须成对,且 key 必须落在当前公司 R2 前缀下(防跨租户引用)
  if (body.thumbKey !== undefined || body.thumbUrl !== undefined) {
    if (!body.thumbKey || !body.thumbUrl) return err('thumbKey/thumbUrl 必须成对提供', 400);
    if (!body.thumbKey.startsWith(`org/${orgId}/`)) return err('文件不属于当前公司', 403);
    patch.thumb_key = body.thumbKey;
    patch.thumb_url = body.thumbUrl;
  }
  if (body.duration !== undefined) {
    const d = Number(body.duration);
    if (!isFinite(d) || d <= 0 || d > 86400) return err('时长非法', 400);
    patch.duration = Math.round(d * 10) / 10;
  }

  await updateItem(env.DB, id, orgId, patch);

  // 先写新、后删旧:DB 已经指向新缩略图,这里只会多删一个已无人引用的对象
  if (patch.thumb_key && body.replaceThumb === true) {
    await cleanupReplacedThumb(env, item.thumb_key, patch.thumb_key, item.file_key);
  }
  return json({ ok: true });
};

// 删除卡片(同时清理 R2 上的文件与缩略图)
export const DELETE: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);
  const id = context.params.id as string;

  const item = await getItem(env.DB, id, orgId);
  if (!item) return err('卡片不存在', 404);

  // 先删 R2 对象(忽略不存在错误),再删数据库记录
  try {
    if (item.file_key) await env.R2.delete(item.file_key);
    if (item.thumb_key) await env.R2.delete(item.thumb_key);
  } catch {
    // R2 删除失败不阻塞数据库记录清理
  }
  await deleteItem(env.DB, id, orgId);
  return json({ ok: true });
};
