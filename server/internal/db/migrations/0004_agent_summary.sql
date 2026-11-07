-- 助手对话的摘要缓存：上下文放不下时，较早的轮次由当前模型压缩成摘要。
-- summary_upto 是摘要覆盖的历史消息条数（按发给模型的顺序，不含空消息）；之后的消息下次增量合并进摘要。
ALTER TABLE agent_chats ADD COLUMN summary      TEXT    NOT NULL DEFAULT '';
ALTER TABLE agent_chats ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0;
