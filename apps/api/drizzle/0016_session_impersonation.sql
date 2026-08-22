-- K49：admin「扮演用户（act as user）」—— 把当前 cookie session 的身份切到任一可加载用户，
-- 用于测试「我的运营」等按人过滤的页面。单层不可嵌套。
-- 扮演中：user_id 指向被扮演者，impersonated_by 记录原身份（admin）；退出时恢复并清空。
-- 审计留痕：impersonated_by 即「谁扮演了谁」；不引入独立事件表（v1 最小化）。
ALTER TABLE sessions ADD COLUMN impersonated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
