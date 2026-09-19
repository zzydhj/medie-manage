-- =============================================================
-- 多租户知识文档库系统 —— 初始化迁移
-- 表:organizations(公司) / users(用户) / menus(多级菜单树) / items(素材卡片)
-- 所有业务数据通过 org_id 做租户隔离
-- =============================================================

-- 公司(组织 / 租户)
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 用户
--   role: superadmin(统管全部公司, org_id 为 NULL) | admin(公司管理员, 预留) | user(仅下载)
--   username 全局唯一(统一登录页)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,                 -- superadmin 为 NULL;admin/user 归属某公司
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('superadmin', 'admin', 'user')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 多级菜单树(1~4 级由 parent_id 链深度表达)
CREATE TABLE IF NOT EXISTS menus (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  parent_id  TEXT,                    -- NULL = 一级菜单
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (org_id)    REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES menus(id)         ON DELETE CASCADE
);

-- 素材卡片(图片 / 视频)
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  menu_id    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('image', 'video')),
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

-- 查询索引:全部围绕 org 作用域
CREATE INDEX IF NOT EXISTS idx_users_org        ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_menus_org        ON menus(org_id);
CREATE INDEX IF NOT EXISTS idx_menus_parent     ON menus(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_org        ON items(org_id);
CREATE INDEX IF NOT EXISTS idx_items_menu       ON items(menu_id);
