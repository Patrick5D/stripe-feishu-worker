# stripe-feishu-worker - Stripe 事件到飞书群通知
TypeScript + Cloudflare Workers + Stripe SDK

<directory>
src/ - Worker 入口与业务逻辑 (1文件: index.ts)
</directory>

<config>
README.md - 公开说明端点、事件、secret 配置方式和新增项目流程，不承载真实密钥
.gitignore - 阻止依赖、环境变量、本地构建产物进入仓库
package.json - 依赖与 npm 脚本
tsconfig.json - Worker TypeScript 类型检查
wrangler.jsonc - Cloudflare Worker 部署配置，绑定 bingo.thecelesteway.com 自定义域
</config>

法则: Stripe 签名先验·飞书只通知·密钥只进 secret
