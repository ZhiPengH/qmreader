# 私有 RSSHub（Twitter 通道）运维说明

位置：Linux `~/apps/news-rsshub/`（compose.yaml + .env）。仅通过 Docker 内部网络
`zonglan-news_default` 供 `qiaomu-qmreader` 访问，不发布任何端口，不走懒猫公网入口。

## 凭据（仅此一处）

`.env` 只放一行，权限 600，永不提交、不打包、不贴聊天：

```
TWITTER_AUTH_TOKEN=<56af8ecd199257e83be5bc53a682fd2b00cad37e>
```

- 是网页 Cookie 的 `auth_token` 值，不是开发者 API Key；不需要 USERNAME/PASSWORD。
- 自检：值应为 40 位十六进制。2026-09-21 事故——粘贴两遍成 80 位（前后两半相同），RSSHub 静默降级游客模式：返回恰好一年前的陈旧快照、部分账号空 feed。症状是「能出数据但永远不更新」，排障先核长度。
- 更换/失效后：编辑 `.env` → `docker compose up -d` 重建 → 用真实账号源验证新帖。
- `DEBUG_INFO` 保持 false：RSSHub debug 日志会打印 token/cookie，禁止开启排障。

## 首次部署 / 更新镜像

```bash
cd ~/apps/news-rsshub
chmod 600 .env
docker compose pull
docker compose up -d
docker image inspect --format '{{index .RepoDigests 0}}' diygod/rsshub:latest
```

把输出到的 digest 记到下方「版本记录」。升级 = `pull` + `up -d`，升级后必须重新做
一次真实新帖验证再记录。

## 验证（不含凭据时 /twitter 路由报错属预期）

```bash
docker ps --filter name=rsshub-x          # Up
# News 容器可达性（Node 26 自带 fetch）：
docker exec qiaomu-qmreader node -e "fetch('http://rsshub-x:1200/').then(r=>console.log('rsshub',r.status)).catch(e=>console.log('ERR',e.message))"
# RSSHub 容器出网（应 200，无需代理；若非 200 再讨论 PROXY_URI）：
docker exec rsshub-x node -e "fetch('https://x.com/').then(r=>console.log('x.com',r.status)).catch(e=>console.log('ERR',e.message))"
```

## News 侧接线（一次）

Linux 的 `~/apps/zonglan-news/.env` 追加一行后重建 News 容器（随下次 deploy 生效）：

```
RSSHUB_INTERNAL_ORIGIN=http://rsshub-x:1200
```

可选调度参数（默认值见 lib/twitter-refresh.js）：`TWITTER_REFRESH_INTERVAL_MS`、
`TWITTER_SWEEP_INTERVAL_MS`、`TWITTER_SWEEP_BATCH_SIZE`。

## 回退

```bash
cd ~/apps/news-rsshub && docker compose down   # 只停本服务，不影响 News
```

News 侧去掉 `RSSHUB_INTERNAL_ORIGIN` 并重建后，Twitter 源回到公共实例行为（预期失败），
其余订阅不受影响；文章与阅读状态全量保留。

## 版本记录

| 日期 | 镜像 digest | 验证人 | 真实新帖验证 |
| --- | --- | --- | --- |
| 2026-09-21 | diygod/rsshub@sha256:22845ada2f14519540e9794f2967f92a2dffe67dbee67c0e6c2572dbb866bc2b | 墨生（用户授权「部署 rsshub」） | 已做：zaobaosg 20 条（最新 2026-09-21T04:02Z）、waylybaye 16 条（09-17）、elonmusk 18 条（当日 02:43Z），snowflake ID 证实当日新鲜；期间修正 token 双粘与 DNS 间歇解析 |
