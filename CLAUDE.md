# stripe-feishu-worker - Stripe / Waffo 事件到飞书群通知
TypeScript + Cloudflare Workers + Stripe SDK + Waffo Pancake SDK

<directory>
src/ - Worker 入口、业务逻辑与纯行为回归测试 (3文件: index.ts, index.test.ts, CLAUDE.md)
</directory>

<config>
README.md - 公开说明端点、事件、secret 配置方式和新增项目流程，不承载真实密钥
.gitignore - 阻止依赖、环境变量、本地构建产物进入仓库
package.json - 依赖与 npm 脚本
tsconfig.json - Worker TypeScript 类型检查，Node 原生 test 由运行时执行并从 Worker 类型域排除
wrangler.jsonc - Cloudflare Worker 部署配置，绑定 bingo.thecelesteway.com 自定义域
</config>

法则: 平台签名先验·飞书只通知·密钥只进 secret

Waffo 仅接收 Build Visuals 店铺的 order.completed。生产固定 prod，复用飞书机器人；不保存 Waffo 商户私钥。
