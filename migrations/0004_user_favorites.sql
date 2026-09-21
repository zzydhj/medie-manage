-- 0004: 用户收藏(个人书签关系表;跨公司存储,前端按当前公司素材过滤展示)
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites (user_id);
