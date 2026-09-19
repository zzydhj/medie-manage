import type { APIRoute } from 'astro';
import { getMenu, listMenus, menuDepth, setMenuOrder } from '../../../lib/db';
import type { MenuRow } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

const MAX_DEPTH = 4;

/** 子树高度(自身为 1) */
function subtreeHeight(all: MenuRow[], id: string): number {
  const children = all.filter((m) => m.parent_id === id);
  if (!children.length) return 1;
  return 1 + Math.max(...children.map((c) => subtreeHeight(all, c.id)));
}

/** id 是否为 node 的祖先(或 node 自身) */
function isSelfOrDescendant(all: MenuRow[], nodeId: string, targetId: string): boolean {
  if (nodeId === targetId) return true;
  let cur = all.find((m) => m.id === targetId);
  while (cur && cur.parent_id) {
    if (cur.parent_id === nodeId) return true;
    cur = all.find((m) => m.id === cur!.parent_id);
  }
  return false;
}

// 拖拽菜单:{ id, parentId, newIndex }
//   parentId = null 表示移到顶级;newIndex 为在新父级下的目标位置
export const PATCH: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);

  let body: { id?: string; parentId?: string | null; newIndex?: number };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }
  const id = body.id;
  if (!id) return err('缺少 id', 400);
  const newIndex = Math.max(0, body.newIndex ?? 0);
  const parentId = body.parentId ?? null;

  const all = await listMenus(env.DB, orgId);
  const node = all.find((m) => m.id === id);
  if (!node) return err('菜单不存在', 404);

  // 校验目标父级
  if (parentId) {
    const parent = await getMenu(env.DB, parentId, orgId);
    if (!parent) return err('目标父菜单不存在', 404);
    // 不能把节点拖进自己或自己的子孙里(防环)
    if (isSelfOrDescendant(all, id, parentId)) {
      return err('不能移动到自身的子菜单下', 400);
    }
    // 移动后:父深度 + 该节点子树高度 ≤ MAX_DEPTH
    const parentDepth = menuDepth(all, parentId);
    const height = subtreeHeight(all, id);
    if (parentDepth + height > MAX_DEPTH) {
      return err(`移动后将超过 ${MAX_DEPTH} 级上限`, 400);
    }
  } else {
    // 移到顶级:自身子树高度 ≤ MAX_DEPTH
    const height = subtreeHeight(all, id);
    if (height > MAX_DEPTH) return err(`移动后将超过 ${MAX_DEPTH} 级上限`, 400);
  }

  // 更新父级(层级变化)
  await env.DB.prepare('UPDATE menus SET parent_id = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(parentId, Math.floor(Date.now() / 1000), id, orgId)
    .run();

  // 同级重排:取新父级下的兄弟(排除自己),在 newIndex 处插入,重新编号
  const siblings = all
    .filter((m) => m.parent_id === parentId && m.id !== id)
    .sort((a, b) => a.sort_order - b.sort_order);
  siblings.splice(Math.min(newIndex, siblings.length), 0, node);
  for (let i = 0; i < siblings.length; i++) {
    await setMenuOrder(env.DB, siblings[i].id, orgId, i);
  }

  return json({ ok: true });
};
