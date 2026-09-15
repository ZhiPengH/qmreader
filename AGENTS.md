# 纵览News 工作入口

- 本仓库基于 qmreader，供纵览News开发；遵守[全局约定](/Users/huangzhipeng/.codex/AGENTS.md)。
- 续作先读[唯一当前工作记录](/Users/huangzhipeng/Documents/App-ZhiXing/NookDeck/docs/zonglan-news.md)，核对当前决定、阶段、NEWS-001、结对实操分工和精确停点。重要决定、阶段结果与下一步更新到该记录，不在本仓库复制维护正文。
- 首次关键操作由用户亲手完成，具体分工以工作记录为准；助手检查或解释不等于用户已经完成练习。
- 修改前检查实际分支与未提交内容，保留他人修改；验证范围与本次改动相称，不把源码检查当成运行验收。
- 不因普通开发任务自动 commit、merge、push、迁移数据或部署。

## 日常更新入口

- 用户已要求将已练习过的备份、SCP、构建、重建与健康检查自动化。使用 `ops/news/deploy.sh`，操作及失败边界见 `ops/news/README.md`。创建脚本不等于授权自动运行生产部署；明确要求部署后才能执行 deploy。
- 日常只返回阶段、结果和日志路径，失败时读取对应阶段日志；人工验收后再按明确授权 commit，push 单独授权。不要粘贴整段正常构建日志，不自动覆盖 .env/data/Compose。
