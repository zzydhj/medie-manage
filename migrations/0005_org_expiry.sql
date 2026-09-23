-- 0005: 公司会员到期时间戳(秒级 unix,超管按公司设置;NULL = 永久有效)
-- 到期后该公司账号(admin/user)登录被拒并提示续费;超级管理员不受限制
ALTER TABLE organizations ADD COLUMN expires_at INTEGER;
