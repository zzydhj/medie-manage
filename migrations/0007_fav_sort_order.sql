-- 0007: 收藏个人自定义排序(收藏视图内拖拽调序,每人独立)。
-- 旧行保持 0,靠 created_at 兜底排序延续历史"收藏时间序";新收藏取 max+1 排到末尾
ALTER TABLE user_favorites ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
