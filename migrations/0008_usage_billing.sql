-- 0008: 计费地基 —— 缩略图体积计量 + 每日存储峰值快照
--
-- 为什么要这两项:存储费要按 Cloudflare R2 的实际成本 1:1(+5% 安全边际)向公司收,
-- 而 R2 是按「对象真实字节」计费的。原表只记了原文件 size,缩略图作为 R2 里的真实对象
-- 却没被计量 → 按 1:1 收会稳亏。
--
-- 同时 R2 的 GB-month 口径是「计费周期内每日存储峰值的平均值」(官方定价页明确),
-- 只看当前值会漏掉周期中途涨上去又删掉的部分,所以必须有每日峰值快照。

-- 1) 缩略图体积(字节)。NULL = 本功能上线前的历史数据未记录,
--    在该公司被「全部重建」补齐之前,其用量统计会偏低(偏低的这部分由 5% 边际吸收)。
ALTER TABLE items ADD COLUMN thumb_size INTEGER;

-- 2) 每日用量峰值快照:一行 = 某公司某日的字节峰值。
--    打点时机:任何会改变公司总用量的写操作(上传建卡 / 删除 / 重建缩略图)前后 upsert。
--    Pages 不支持 Cron Trigger,但用量只会在这些时刻变化,样本恰好落在变化点上,无需定时任务。
CREATE TABLE IF NOT EXISTS usage_snapshots (
  org_id     TEXT    NOT NULL,
  day        TEXT    NOT NULL, -- YYYY-MM-DD,按东八区归档(与到期日「当日末」口径一致)
  bytes      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, day)
);
