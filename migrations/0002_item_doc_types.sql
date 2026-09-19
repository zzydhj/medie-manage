-- =============================================================
-- 扩展 items.type:在 图片/视频 基础上,新增 PDF / Word / Excel 文档类型
-- SQLite 无法直接修改 CHECK 约束,采用:建新表 → 迁数据 → 删旧表 → 改名 → 重建索引
-- =============================================================

PRAGMA foreign_keys = OFF;

ALTER TABLE items RENAME TO items_old;

CREATE TABLE items (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  menu_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('image', 'video', 'pdf', 'word', 'excel')),
  title      TEXT NOT NULL,
  file_key   TEXT NOT NULL,           -- R2 对象 key(固定不变)
  file_url   TEXT NOT NULL,           -- 稳定访问 URL(/api/file/<key>)
  thumb_key  TEXT,                    -- 视频缩略图 R2 key(可空)
  thumb_url  TEXT,
  mime       TEXT,
  size       INTEGER,
  filename   TEXT,                    -- 原始文件名,下载时用于 Content-Disposition
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (org_id)  REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_id) REFERENCES menus(id)         ON DELETE CASCADE
);

INSERT INTO items
  (id, org_id, menu_id, type, title, file_key, file_url, thumb_key, thumb_url, mime, size, filename, sort_order, created_at, updated_at)
SELECT
   id, org_id, menu_id, type, title, file_key, file_url, thumb_key, thumb_url, mime, size, filename, sort_order, created_at, updated_at
FROM items_old;

DROP TABLE items_old;

-- 重建随旧表一起被删除的索引
CREATE INDEX IF NOT EXISTS idx_items_org  ON items(org_id);
CREATE INDEX IF NOT EXISTS idx_items_menu ON items(menu_id);

PRAGMA foreign_keys = ON;
