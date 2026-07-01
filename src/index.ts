/**
 * [INPUT]: 依赖 stripe 的 webhook 验签，依赖 Cloudflare Workers 的 fetch/crypto 运行时
 * [OUTPUT]: 对外提供 /gptimage2/stripe/webhook HTTP 入口，把 Stripe 付款事件转成飞书自定义通知
 * [POS]: src 的唯一 Worker 入口，负责站点路由、事件格式化、飞书投递
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import Stripe from "stripe";

type Env = {
  GPTIMAGE2_STRIPE_WEBHOOK_SECRET: string;
  FEISHU_WEBHOOK_URL: string;
  FEISHU_BOT_SECRET: string;
};

type SiteConfig = {
  slug: string;
  label: string;
  stripeWebhookSecret: string;
};

const stripe = new Stripe("unused", {
  httpClient: Stripe.createFetchHttpClient(),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "stripe-feishu-worker" });
    }

    const site = getSite(url.pathname, env);
    if (!site) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!site.stripeWebhookSecret) {
      return new Response("Missing site Stripe webhook secret", { status: 500 });
    }

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response("Missing Stripe signature", { status: 400 });
    }

    let event: Stripe.Event;
    const rawBody = await request.text();

    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        site.stripeWebhookSecret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch (error) {
      return new Response(`Invalid Stripe signature: ${String(error)}`, {
        status: 400,
      });
    }

    const message = formatEvent(site, event);
    console.log("stripe_event", JSON.stringify({ site: site.slug, type: event.type, hasMessage: Boolean(message) }));
    if (message) {
      await sendFeishu(env, message);
    }

    return Response.json({ ok: true, site: site.slug, event: event.type });
  },
};

function getSite(pathname: string, env: Env): SiteConfig | null {
  if (pathname !== "/gptimage2/stripe/webhook") return null;

  return {
    slug: "gptimage2",
    label: "GPT Image 2",
    stripeWebhookSecret: env.GPTIMAGE2_STRIPE_WEBHOOK_SECRET,
  };
}

function formatEvent(site: SiteConfig, event: Stripe.Event): string | null {
  switch (event.type) {
    case "checkout.session.completed":
      return formatCheckoutCompleted(site, event);
    case "invoice.payment_succeeded":
      return formatInvoicePaymentSucceeded(site, event);
    case "invoice.payment_failed":
      return formatInvoicePaymentFailed(site, event);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return formatSubscriptionEvent(site, event);
    case "charge.refunded":
      return formatChargeRefunded(site, event);
    default:
      return null;
  }
}

function formatCheckoutCompleted(site: SiteConfig, event: Stripe.Event): string {
  const session = event.data.object as Stripe.Checkout.Session;

  return formatPaymentNotice(
    site,
    inferCheckoutKind(session),
    session.amount_total,
    session.currency,
    session.customer_email ?? session.customer,
  );
}

function formatInvoicePaymentSucceeded(site: SiteConfig, event: Stripe.Event): string {
  const invoice = event.data.object as Stripe.Invoice;

  return formatPaymentNotice(
    site,
    inferInvoiceKind(invoice),
    invoice.amount_paid,
    invoice.currency,
    invoice.customer_email ?? invoice.customer,
  );
}

function formatInvoicePaymentFailed(site: SiteConfig, event: Stripe.Event): string {
  const invoice = event.data.object as Stripe.Invoice;

  return lines([
    `[${site.label}] Stripe 账单支付失败`,
    `event_id: ${event.id}`,
    `customer: ${invoice.customer ?? "unknown"}`,
    `amount_due: ${formatAmount(invoice.amount_due, invoice.currency)}`,
    `created: ${formatUnix(event.created)}`,
  ]);
}

function formatSubscriptionEvent(site: SiteConfig, event: Stripe.Event): string {
  const subscription = event.data.object as Stripe.Subscription;

  return lines([
    `[${site.label}] Stripe 订阅事件`,
    `type: ${event.type}`,
    `event_id: ${event.id}`,
    `customer: ${subscription.customer}`,
    `status: ${subscription.status}`,
    `created: ${formatUnix(event.created)}`,
  ]);
}

function formatChargeRefunded(site: SiteConfig, event: Stripe.Event): string {
  const charge = event.data.object as Stripe.Charge;

  return lines([
    `[${site.label}] Stripe 退款`,
    `event_id: ${event.id}`,
    `customer: ${charge.customer ?? "unknown"}`,
    `amount_refunded: ${formatAmount(charge.amount_refunded, charge.currency)}`,
    `created: ${formatUnix(event.created)}`,
  ]);
}

function formatAmount(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return "unknown";
  return `${(amount / 100).toFixed(2)} ${(currency ?? "").toUpperCase()}`;
}

function formatPaymentNotice(
  site: SiteConfig,
  kind: string,
  amount: number | null | undefined,
  currency: string | null | undefined,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string {
  return lines([
    `💰 [${kind}] ！ ${site.label}`,
    `金额: ${formatDisplayAmount(amount, currency)}`,
    `客户: ${formatCustomer(customer)}`,
  ]);
}

function inferCheckoutKind(session: Stripe.Checkout.Session): string {
  const metadataKind = inferMetadataKind(session.metadata);
  if (metadataKind) return metadataKind;
  if (session.mode === "payment") return "积分包";
  return "订阅";
}

function inferInvoiceKind(invoice: Stripe.Invoice): string {
  const metadataKind = inferMetadataKind(invoice.metadata);
  if (metadataKind) return metadataKind;

  const interval = invoice.lines.data.map(readRecurringInterval).find(Boolean);

  if (interval === "year") return "年费";
  if (interval === "month") return "月费";
  return "订阅";
}

function inferMetadataKind(metadata: Stripe.Metadata | null): string | null {
  if (!metadata) return null;

  const value = [
    metadata.kind,
    metadata.type,
    metadata.product_type,
    metadata.package_type,
    metadata.plan_type,
    metadata.billing_cycle,
    metadata.interval,
    metadata.price_interval,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (value.includes("credit") || value.includes("pack") || value.includes("积分")) return "积分包";
  if (value.includes("year") || value.includes("annual") || value.includes("年")) return "年费";
  if (value.includes("month") || value.includes("monthly") || value.includes("月")) return "月费";
  return null;
}

function readRecurringInterval(line: Stripe.InvoiceLineItem): string | undefined {
  const value = line as unknown as Record<string, unknown>;
  return findFirstString(value, [
    ["pricing", "price_details", "recurring", "interval"],
    ["price", "recurring", "interval"],
    ["plan", "interval"],
  ]);
}

function findFirstString(value: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    const found = findString(value, path);
    if (found) return found;
  }

  return undefined;
}

function findString(value: Record<string, unknown>, path: string[]): string | undefined {
  let cursor: unknown = value;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return typeof cursor === "string" ? cursor : undefined;
}

function formatDisplayAmount(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return "unknown";

  const major = (amount / 100).toFixed(2);
  const normalizedCurrency = (currency ?? "").toLowerCase();
  if (normalizedCurrency === "usd") return `$${major}`;
  return `${major} ${(currency ?? "").toUpperCase()}`;
}

function formatCustomer(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined): string {
  if (!customer) return "unknown";
  if (typeof customer === "string") return customer;
  if ("email" in customer && customer.email) return customer.email;
  return customer.id;
}

function formatUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function lines(values: string[]): string {
  return values.join("\n");
}

async function sendFeishu(env: Env, text: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    timestamp,
    sign: await feishuSign(timestamp, env.FEISHU_BOT_SECRET),
    msg_type: "text",
    content: { text },
  };

  const response = await fetch(env.FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${body}`);
  }

  const result = parseFeishuResult(body);
  if (!result.ok) {
    throw new Error(`Feishu webhook rejected: ${body}`);
  }

  console.log("feishu_delivered", JSON.stringify({ status: response.status, body }));
}

async function feishuSign(timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function parseFeishuResult(body: string): { ok: boolean } {
  try {
    const result = JSON.parse(body) as Record<string, unknown>;
    const code = result.code ?? result.StatusCode;
    return { ok: code === 0 || code === "0" };
  } catch {
    return { ok: false };
  }
}
