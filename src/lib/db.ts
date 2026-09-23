// D1 数据访问层:所有查询都围绕 org 作用域,保证租户隔离。
// 类型定义见 src/env.d.ts(D1Database / R2Bucket 来自 @cloudflare/workers-types)

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: number;
  expires_at: number | null; // 会员到期(秒级 unix,当日末);NULL = 永久有效
}

export interface UserRow {
  id: string;
  org_id: string | null;
  username: string;
  password_hash: string;
  salt: string;
  role: SessionUser['role'];
  grid_cols: number | null;   // 账户级 UI 偏好:每行列数;NULL=未保存,前端按设备取默认
  created_at: number;
}

export interface MenuRow {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
}

export interface ItemRow {
  id: string;
  org_id: string;
  menu_id: string;
  type: 'image' | 'video' | 'pdf' | 'word' | 'excel';
  title: string;
  file_key: string;
  file_url: string;
  thumb_key: string | null;
  thumb_url: string | null;
  mime: string | null;
  size: number | null;
  filename: string | null;
  duration: number | null;
  sort_order: number;
}

/** 生成 UUID(优先用原生 crypto.randomUUID) */
export function newId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ------------------------- 组织 -------------------------

export async function listOrgs(db: D1Database): Promise<Organization[]> {
  const { results } = await db
    .prepare('SELECT id, name, slug, created_at, expires_at FROM organizations ORDER BY created_at ASC')
    .all<Organization>();
  return results ?? [];
}

export async function getOrg(db: D1Database, id: string): Promise<Organization | null> {
  return db
    .prepare('SELECT id, name, slug, created_at, expires_at FROM organizations WHERE id = ?')
    .bind(id)
    .first<Organization>();
}

/** 会员到期判定:now 超过 expires_at 即到期;NULL/0 = 永久有效 */
export function orgExpired(expiresAt: number | null | undefined): boolean {
  return typeof expiresAt === 'number' && expiresAt > 0 && now() > expiresAt;
}

export async function setOrgExpiry(
  db: D1Database,
  id: string,
  expiresAt: number | null,
): Promise<void> {
  await db.prepare('UPDATE organizations SET expires_at = ? WHERE id = ?').bind(expiresAt, id).run();
}

export interface OrgStorage {
  org_id: string;
  bytes: number; // 素材原文件 size 合计(不含缩略图)
  count: number; // 素材条数
}

/** 统计存储用量:orgId 为 null 时按公司分组返回全部,否则只返回该公司一条 */
export async function getStorageByOrg(
  db: D1Database,
  orgId: string | null,
): Promise<OrgStorage[]> {
  if (orgId) {
    const row = await db
      .prepare('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM items WHERE org_id = ?')
      .bind(orgId)
      .first<{ bytes: number; count: number }>();
    return [{ org_id: orgId, bytes: row?.bytes ?? 0, count: row?.count ?? 0 }];
  }
  const { results } = await db
    .prepare(
      'SELECT org_id, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM items GROUP BY org_id',
    )
    .all<OrgStorage>();
  return results ?? [];
}

export async function createOrg(
  db: D1Database,
  name: string,
  slug: string,
): Promise<Organization> {
  const id = newId();
  await db
    .prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, slug, now())
    .run();
  return { id, name, slug, created_at: now(), expires_at: null };
}

export async function deleteOrg(db: D1Database, id: string): Promise<void> {
  // 外键 ON DELETE CASCADE 会连带删除 menus / items / users(D1 默认强制外键,无需 pragma;
  // D1Database 也没有 pragma 方法,调用会直接 TypeError 致 500)
  await db.prepare('DELETE FROM organizations WHERE id = ?').bind(id).run();
}

// ------------------------- 用户 -------------------------

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function listUsers(db: D1Database, orgId: string | null): Promise<UserRow[]> {
  if (orgId === null) {
    const { results } = await db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all<UserRow>();
    return results ?? [];
  }
  const { results } = await db
    .prepare('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC')
    .bind(orgId)
    .all<UserRow>();
  return results ?? [];
}

export async function createUser(
  db: D1Database,
  u: {
    orgId: string | null;
    username: string;
    passwordHash: string;
    salt: string;
    role: SessionUser['role'];
  },
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      'INSERT INTO users (id, org_id, username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, u.orgId, u.username, u.passwordHash, u.salt, u.role, now())
    .run();
  return id;
}

export async function deleteUser(db: D1Database, id: string): Promise<void> {
  // 连带清理收藏记录(运行时未必强制外键 CASCADE)
  await db.prepare('DELETE FROM user_favorites WHERE user_id = ?').bind(id).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

// 保存账户级 UI 偏好(每行列数);cols 传 null 表示清除、回退设备默认
export async function setUserGridCols(
  db: D1Database,
  id: string,
  cols: number | null,
): Promise<void> {
  await db.prepare('UPDATE users SET grid_cols = ? WHERE id = ?').bind(cols, id).run();
}

// ------------------------- 用户收藏 -------------------------

export async function listFavoriteItemIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT item_id FROM user_favorites WHERE user_id = ? ORDER BY created_at ASC')
    .bind(userId)
    .all<{ item_id: string }>();
  return (results ?? []).map((r) => r.item_id);
}

export async function setFavorite(
  db: D1Database,
  userId: string,
  itemId: string,
  on: boolean,
): Promise<void> {
  if (on) {
    await db
      .prepare('INSERT OR IGNORE INTO user_favorites (user_id, item_id, created_at) VALUES (?, ?, ?)')
      .bind(userId, itemId, now())
      .run();
  } else {
    await db
      .prepare('DELETE FROM user_favorites WHERE user_id = ? AND item_id = ?')
      .bind(userId, itemId)
      .run();
  }
}

// ------------------------- 菜单 -------------------------

export async function listMenus(db: D1Database, orgId: string): Promise<MenuRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM menus WHERE org_id = ? ORDER BY sort_order ASC, created_at ASC')
    .bind(orgId)
    .all<MenuRow>();
  return results ?? [];
}

export async function getMenu(db: D1Database, id: string, orgId: string): Promise<MenuRow | null> {
  return db
    .prepare('SELECT * FROM menus WHERE id = ? AND org_id = ?')
    .bind(id, orgId)
    .first<MenuRow>();
}

/** 计算某菜单的层级深度(1 为顶级) */
export function menuDepth(menus: MenuRow[], id: string): number {
  const byId = new Map(menus.map((m) => [m.id, m]));
  let depth = 1;
  let cur = byId.get(id);
  while (cur && cur.parent_id) {
    depth++;
    cur = byId.get(cur.parent_id);
    if (depth > 10) break; // 防御死循环
  }
  return depth;
}

export async function nextSortOrder(
  db: D1Database,
  orgId: string,
  parentId: string | null,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM menus
       WHERE org_id = ? AND (parent_id IS ? )`,
    )
    .bind(orgId, parentId)
    .first<{ next: number }>();
  return row?.next ?? 0;
}

export async function createMenu(
  db: D1Database,
  orgId: string,
  name: string,
  parentId: string | null,
): Promise<MenuRow> {
  const id = newId();
  const sort = await nextSortOrder(db, orgId, parentId);
  await db
    .prepare(
      'INSERT INTO menus (id, org_id, parent_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, orgId, parentId, name, sort, now(), now())
    .run();
  return { id, org_id: orgId, parent_id: parentId, name, sort_order: sort };
}

export async function renameMenu(
  db: D1Database,
  id: string,
  orgId: string,
  name: string,
): Promise<void> {
  await db
    .prepare('UPDATE menus SET name = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(name, now(), id, orgId)
    .run();
}

export async function deleteMenu(db: D1Database, id: string, orgId: string): Promise<void> {
  // 手动级联:先删子孙菜单与相关 items,再删自身(兼容未开启外键的运行时)
  const all = await listMenus(db, orgId);
  const toDelete = new Set<string>([id]);
  let added = true;
  while (added) {
    added = false;
    for (const m of all) {
      if (m.parent_id && toDelete.has(m.parent_id) && !toDelete.has(m.id)) {
        toDelete.add(m.id);
        added = true;
      }
    }
  }
  const ids = [...toDelete];
  const placeholders = ids.map(() => '?').join(',');
  // 连带清理指向这些素材的收藏记录
  await db
    .prepare(
      `DELETE FROM user_favorites WHERE item_id IN (SELECT id FROM items WHERE menu_id IN (${placeholders}))`,
    )
    .bind(...ids)
    .run();
  await db
    .prepare(`DELETE FROM items WHERE menu_id IN (${placeholders})`)
    .bind(...ids)
    .run();
  await db
    .prepare(`DELETE FROM menus WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}

export async function moveMenu(
  db: D1Database,
  id: string,
  orgId: string,
  parentId: string | null,
  sortOrder: number,
): Promise<void> {
  await db
    .prepare('UPDATE menus SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(parentId, sortOrder, now(), id, orgId)
    .run();
}

export async function setMenuOrder(
  db: D1Database,
  id: string,
  orgId: string,
  sortOrder: number,
): Promise<void> {
  await db
    .prepare('UPDATE menus SET sort_order = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(sortOrder, now(), id, orgId)
    .run();
}

// ------------------------- 素材卡片 -------------------------

export async function listItems(db: D1Database, orgId: string): Promise<ItemRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM items WHERE org_id = ? ORDER BY sort_order ASC, created_at ASC')
    .bind(orgId)
    .all<ItemRow>();
  return results ?? [];
}

export async function getItem(db: D1Database, id: string, orgId: string): Promise<ItemRow | null> {
  return db
    .prepare('SELECT * FROM items WHERE id = ? AND org_id = ?')
    .bind(id, orgId)
    .first<ItemRow>();
}

export async function nextItemSortOrder(
  db: D1Database,
  orgId: string,
  menuId: string,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM items WHERE org_id = ? AND menu_id = ?',
    )
    .bind(orgId, menuId)
    .first<{ next: number }>();
  return row?.next ?? 0;
}

export async function createItem(
  db: D1Database,
  it: Omit<ItemRow, 'id' | 'org_id' | 'sort_order'> & { orgId: string; sort?: number },
): Promise<string> {
  const id = newId();
  const sort = it.sort ?? (await nextItemSortOrder(db, it.orgId, it.menu_id));
  await db
    .prepare(
      `INSERT INTO items
       (id, org_id, menu_id, type, title, file_key, file_url, thumb_key, thumb_url, mime, size, filename, duration, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      it.orgId,
      it.menu_id,
      it.type,
      it.title,
      it.file_key,
      it.file_url,
      it.thumb_key,
      it.thumb_url,
      it.mime,
      it.size,
      it.filename,
      it.duration,
      sort,
      now(),
      now(),
    )
    .run();
  return id;
}

export async function updateItem(
  db: D1Database,
  id: string,
  orgId: string,
  patch: {
    title?: string;
    menu_id?: string;
    thumb_key?: string | null;
    thumb_url?: string | null;
    duration?: number | null;
  },
): Promise<void> {
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) {
    fields.push('title = ?');
    vals.push(patch.title);
  }
  if (patch.menu_id !== undefined) {
    fields.push('menu_id = ?');
    vals.push(patch.menu_id);
  }
  if (patch.thumb_key !== undefined) {
    fields.push('thumb_key = ?');
    vals.push(patch.thumb_key);
  }
  if (patch.thumb_url !== undefined) {
    fields.push('thumb_url = ?');
    vals.push(patch.thumb_url);
  }
  if (patch.duration !== undefined) {
    fields.push('duration = ?');
    vals.push(patch.duration);
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(now());
  await db
    .prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`)
    .bind(...vals, id, orgId)
    .run();
}

export async function deleteItem(db: D1Database, id: string, orgId: string): Promise<void> {
  // 连带清理指向该素材的收藏记录
  await db.prepare('DELETE FROM user_favorites WHERE item_id = ?').bind(id).run();
  await db.prepare('DELETE FROM items WHERE id = ? AND org_id = ?').bind(id, orgId).run();
}

export async function setItemOrder(
  db: D1Database,
  id: string,
  orgId: string,
  sortOrder: number,
  menuId?: string,
): Promise<void> {
  if (menuId !== undefined) {
    await db
      .prepare('UPDATE items SET sort_order = ?, menu_id = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(sortOrder, menuId, now(), id, orgId)
      .run();
  } else {
    await db
      .prepare('UPDATE items SET sort_order = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(sortOrder, now(), id, orgId)
      .run();
  }
}
