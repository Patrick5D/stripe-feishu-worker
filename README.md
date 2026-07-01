# Stripe Feishu Worker

Cloudflare Worker that verifies Stripe webhook events and sends selected payment notifications to a Feishu custom group bot.

## Endpoint

```text
POST https://bingo.thecelesteway.com/gptimage2/stripe/webhook
GET  https://bingo.thecelesteway.com/health
```

## Required Secrets

Configure secrets with Wrangler. Do not commit real values.

```bash
npx wrangler secret put GPTIMAGE2_STRIPE_WEBHOOK_SECRET
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_BOT_SECRET
```

## Events

Custom payment notices are sent for:

```text
checkout.session.completed
invoice.payment_succeeded
```

Other supported notices:

```text
invoice.payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.refunded
```

## Development

```bash
npm install
npm run typecheck
npx wrangler deploy
```
