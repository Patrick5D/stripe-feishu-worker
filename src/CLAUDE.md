# src/
> L2 | 父级: /CLAUDE.md

index.ts: 分发 Stripe/Waffo 通知路由，先验签，再格式化并等待飞书业务成功；不访问产品账本。
index.test.ts: 校验归因、金额、渠道隔离、验签拒绝和飞书失败重试语义；不发送真实消息。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
