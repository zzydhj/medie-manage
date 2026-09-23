import type { APIRoute } from 'astro';
import { listFavoriteItemIds, listMenus } from '../../lib/db';
import { err, getEnv, isResponse, json, requireOrg, requireUser } from '../../lib/api';

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

// 某菜单及其所有子孙菜单的 id(点一级菜单看全部下级内容)
function subtreeIds(tree: MenuNode[], rootId: string): string[] {
  const find = (nodes: MenuNode[]): MenuNode | null => {
    for (const n of nodes) {
      if (n.id === rootId) return n;
      const r = find(n.children);
      if (r) return r;
    }
    return null;
  };
  const out: string[] = [];
  const collect = (n: MenuNode) => {
    out.push(n.id);
    n.children.forEach(collect);
  };
  const root = find(tree);
  if (root) collect(root);
  return out;
}

// 按 menu_id 分组的直接计数 → 沿树聚合为子树总数(侧栏徽章用)
function aggregateCounts(tree: MenuNode[], direct: Map<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  const agg = (n: MenuNode): number => {
    let s = direct.get(n.id) ?? 0;
    for (const c of n.children) s += agg(c);
    counts[n.id] = s;
    return s;
  };
  tree.forEach(agg);
  return counts;
}

interface ItemRow {
  id: string;
  menu_id: string;
  type: string;
  title: string;
  file_url: string;
  thumb_url: string | null;
  filename: string | null;
  size: number | null;
  duration: number | null;
  sort_order: number;
}

// 返回当前公司作用域下的菜单树 + 分页后的卡片列表。
// 查询参数:meta=1 只返树/计数;否则 page/pageSize/q/fav/menuId 控制分页与过滤(服务端搜索)。
export const GET: APIRoute = async (context) => {
  const scope = await requireOrg(context);
  if (isResponse(scope)) return scope;
  const user = requireUser(context.locals);
  if (isResponse(user)) return user;
  const env = getEnv(context.locals);
  const url = new URL(context.request.url);

  const menus = await listMenus(env.DB, scope.orgId);
  const tree = buildTree(menus);

  const grouped = await env.DB
    .prepare('SELECT menu_id, COUNT(*) AS c FROM items WHERE org_id = ? GROUP BY menu_id')
    .bind(scope.orgId)
    .all<{ menu_id: string; c: number }>();
  const directMap = new Map(grouped.results.map((r) => [r.menu_id, r.c]));
  const counts = aggregateCounts(tree, directMap);
  // 直挂计数(未聚合):供前端解释「父级徽章 ≠ 子级徽章之和」——差值即直挂在该级菜单下的素材
  const directCounts: Record<string, number> = {};
  directMap.forEach((c, id) => {
    directCounts[id] = c;
  });

  const favRow = await env.DB
    .prepare(
      'SELECT COUNT(*) AS c FROM user_favorites f JOIN items i ON i.id = f.item_id WHERE f.user_id = ? AND i.org_id = ?',
    )
    .bind(user.id, scope.orgId)
    .first<{ c: number }>();
  const favCount = favRow?.c ?? 0;

  // meta=1:首屏定视图用,只要树+计数,不拉素材
  if (url.searchParams.get('meta') === '1') {
    return json({ menus: tree, counts, directCounts, favCount });
  }

  const q = (url.searchParams.get('q') ?? '').trim();
  const fav = url.searchParams.get('fav') === '1';
  const menuId = url.searchParams.get('menuId');
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '36', 10) || 36));

  const favorites = await listFavoriteItemIds(env.DB, user.id);

  const where: string[] = ['org_id = ?'];
  const params: (string | number)[] = [scope.orgId];
  if (q) {
    where.push('(title LIKE ? OR filename LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  } else if (fav) {
    if (!favorites.length) {
      return json({ menus: tree, counts, directCounts, favCount, favorites, items: [], total: 0, page, pageSize });
    }
    where.push(`id IN (${favorites.map(() => '?').join(',')})`);
    params.push(...favorites);
  } else if (menuId) {
    const ids = subtreeIds(tree, menuId);
    if (!ids.length) return err('菜单不存在', 404);
    where.push(`menu_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const whereSql = where.join(' AND ');

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${whereSql}`)
    .bind(...params)
    .first<{ c: number }>();
  const total = totalRow?.c ?? 0;
  const { results } = await env.DB
    .prepare(
      `SELECT id, menu_id, type, title, file_url, thumb_url, filename, size, duration, sort_order FROM items WHERE ${whereSql} ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<ItemRow>();

  return json({
    menus: tree,
    counts,
    directCounts,
    favCount,
    favorites,
    total,
    page,
    pageSize,
    items: results.map((it) => ({
      id: it.id,
      menu_id: it.menu_id,
      type: it.type,
      title: it.title,
      file_url: it.file_url,
      thumb_url: it.thumb_url,
      filename: it.filename,
      size: it.size, // 批量上传去重用:同一公司内「文件名 + 大小」相同即视为重复
      duration: it.duration, // 视频时长(秒):卡片左下角时长胶囊
      sort_order: it.sort_order,
    })),
  });
};
