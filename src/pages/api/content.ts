import type { APIRoute } from 'astro';
import { listFavoriteItemIds, listItems, listMenus } from '../../lib/db';
import { getEnv, isResponse, json, requireOrg, requireUser } from '../../lib/api';

export interface MenuNode {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  children: MenuNode[];
}

function buildTree(rows: { id: string; name: string; parent_id: string | null; sort_order: number }[]): MenuNode[] {
  const map = new Map<string, MenuNode>();
  rows.forEach((r) => map.set(r.id, { ...r, children: [] }));
  const roots: MenuNode[] = [];
  rows.forEach((r) => {
    const node = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) {
      map.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (nodes: MenuNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

// 返回当前公司作用域下的完整菜单树与卡片列表
export const GET: APIRoute = async (context) => {
  const scope = await requireOrg(context);
  if (isResponse(scope)) return scope;
  const user = requireUser(context.locals);
  if (isResponse(user)) return user;
  const env = getEnv(context.locals);

  const [menus, items, favorites] = await Promise.all([
    listMenus(env.DB, scope.orgId),
    listItems(env.DB, scope.orgId),
    listFavoriteItemIds(env.DB, user.id),
  ]);

  return json({
    menus: buildTree(menus),
    items: items.map((it) => ({
      id: it.id,
      menu_id: it.menu_id,
      type: it.type,
      title: it.title,
      file_url: it.file_url,
      thumb_url: it.thumb_url,
      filename: it.filename,
      sort_order: it.sort_order,
    })),
    favorites,
  });
};
