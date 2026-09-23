-- 素材播放时长(秒,可空):视频卡片左下角时长胶囊用。
-- 新视频上传时浏览器端提取随创建写入;存量视频在灯箱首次播放时惰性回填。
ALTER TABLE items ADD COLUMN duration REAL;
