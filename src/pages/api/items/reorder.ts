import type { APIRoute } from 'astro';
import { getMenu, listItems, setItemOrder } from '../../../lib/db';
import { err, getEnv, isResponse, json, requireAdminOrg } from '../../../lib/api';

// 拖拽卡片排序。两种入参任选其一:
//   A) { id, menuId, newIndex }        —— 把某卡片移动到 menuId 下的 newIndex 位置
//   B) { menuId, orderedIds: string[] } —— 直接给定某菜单下卡片的完整新顺序
export const PATCH: APIRoute = async (context) => {
  const guard = await requireAdminOrg(context);
  if (isResponse(guard)) return guard;
  const { orgId } = guard;
  const env = getEnv(context.locals);

  let body: { id?: string; menuId?: string; newIndex?: number; orderedIds?: string[] };
  try {
    body = await context.request.json();
  } catch {
    return err('请求体格式错误', 400);
  }

  const allItems = await listItems(env.DB, orgId);

  // 形式 B:整表重排
  if (Array.isArray(body.orderedIds) && body.menuId) {
    const menu = await getMenu(env.DB, body.menuId, orgId);
    if (!menu) return err('目标菜单不存在', 404);
    for (let i = 0; i < body.orderedIds.length; i++) {
      const it = allItems.find((x) => x.id === body.orderedIds![i]);
      if (!it) continue;
      await setItemOrder(env.DB, it.id, orgId, i, body.menuId);
    }
    return json({ ok: true });
  }

  // 形式 A:单个卡片移动
  const id = body.id;
  const menuId = body.menuId;
  if (!id || !menuId) return err('缺少 id 或 menuId', 400);
  const newIndex = Math.max(0, body.newIndex ?? 0);

  const node = allItems.find((x) => x.id === id);
  if (!node) return err('卡片不存在', 404);
  const menu = await getMenu(env.DB, menuId, orgId);
  if (!menu) return err('目标菜单不存在', 404);

  // 目标菜单下的其它卡片(排除自己),按现序排列,在 newIndex 处插入后重新编号
  const siblings = allItems
    .filter((x) => x.menu_id === menuId && x.id !== id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const moved = { ...node, menu_id: menuId };
  siblings.splice(Math.min(newIndex, siblings.length), 0, moved);
  for (let i = 0; i < siblings.length; i++) {
    await setItemOrder(env.DB, siblings[i].id, orgId, i, menuId);
  }

  return json({ ok: true });
};
