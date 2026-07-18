/**
 * [INPUT]: 依赖 stripe 的 webhook 验签，依赖 Cloudflare Workers 的 fetch/crypto 运行时
 * [OUTPUT]: 对外提供多站点 Stripe webhook 路由，把 Stripe 付款事件转成飞书卡片通知
 * [POS]: src 的唯一 Worker 入口，负责站点路由、事件格式化、飞书投递
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import Stripe from "stripe";

type Env = {
  GPTIMAGE2_STRIPE_WEBHOOK_SECRET: string;
  ERASIO_STRIPE_WEBHOOK_SECRET: string;
  PLAYITOUT_STRIPE_WEBHOOK_SECRET: string;
  FEISHU_WEBHOOK_URL: string;
  FEISHU_BOT_SECRET: string;
};

type SiteConfig = {
  slug: string;
  label: string;
  stripeWebhookSecret: string;
};

type StripeWebhookSecretName = Extract<
  keyof Env,
  `${string}_STRIPE_WEBHOOK_SECRET`
>;

type SiteDefinition = Omit<SiteConfig, "stripeWebhookSecret"> & {
  stripeWebhookSecretName: StripeWebhookSecretName;
};

type Notice = {
  title: string;
  template: "green" | "red" | "orange" | "blue";
  fields: Array<{ label: string; value?: string | null }>;
};

type PaymentDetails = {
  kind: string;
  amount: number | null | undefined;
  currency: string | null | undefined;
  email?: string | null;
  customer?: string | null;
  originCountry?: string | null;
  country?: string | null;
};

const sites: Record<string, SiteDefinition> = {
  "/gptimage2/stripe/webhook": {
    slug: "gptimage2",
    label: "GPT Image 2",
    stripeWebhookSecretName: "GPTIMAGE2_STRIPE_WEBHOOK_SECRET",
  },
  "/erasio/stripe/webhook": {
    slug: "erasio",
    label: "Erasio",
    stripeWebhookSecretName: "ERASIO_STRIPE_WEBHOOK_SECRET",
  },
  "/playitout/stripe/webhook": {
    slug: "playitout",
    label: "PlayItOut",
    stripeWebhookSecretName: "PLAYITOUT_STRIPE_WEBHOOK_SECRET",
  },
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
      return new Response("Missing site Stripe webhook secret", {
        status: 500,
      });
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
    console.log(
      "stripe_event",
      JSON.stringify({
        site: site.slug,
        type: event.type,
        hasMessage: Boolean(message),
      }),
    );
    if (message) {
      await sendFeishu(env, message);
    }

    return Response.json({ ok: true, site: site.slug, event: event.type });
  },
};

function getSite(pathname: string, env: Env): SiteConfig | null {
  const site = sites[pathname];
  if (!site) return null;

  return {
    slug: site.slug,
    label: site.label,
    stripeWebhookSecret: env[site.stripeWebhookSecretName],
  };
}

function formatEvent(site: SiteConfig, event: Stripe.Event): Notice | null {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
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

function formatCheckoutCompleted(
  site: SiteConfig,
  event: Stripe.Event,
): Notice | null {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== "payment" || session.payment_status !== "paid")
    return null;

  return formatPaymentNotice(site, event, {
    kind: inferCheckoutKind(session),
    amount: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? session.customer_email,
    customer: formatCustomer(session.customer),
    originCountry: readMetadataCountry(session.metadata),
    country: session.customer_details?.address?.country,
  });
}

function formatInvoicePaymentSucceeded(
  site: SiteConfig,
  event: Stripe.Event,
): Notice | null {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.billing_reason?.startsWith("subscription")) return null;
  if (invoice.amount_paid <= 0) return null;

  return formatPaymentNotice(site, event, {
    kind: inferInvoiceKind(invoice),
    amount: invoice.amount_paid,
    currency: invoice.currency,
    email: invoice.customer_email,
    customer: formatCustomer(invoice.customer),
    originCountry: readInvoiceOriginCountry(invoice),
    country: invoice.customer_address?.country,
  });
}

function formatInvoicePaymentFailed(
  site: SiteConfig,
  event: Stripe.Event,
): Notice {
  const invoice = event.data.object as Stripe.Invoice;

  return {
    title: `⚠️ ${site.label} · 账单支付失败`,
    template: "red",
    fields: eventFields(event, [
      {
        label: "应付金额",
        value: formatDisplayAmount(invoice.amount_due, invoice.currency),
      },
      customerField(invoice.customer_email, formatCustomer(invoice.customer)),
      {
        label: "账单国家",
        value: formatCountry(invoice.customer_address?.country),
      },
    ]),
  };
}

function formatSubscriptionEvent(
  site: SiteConfig,
  event: Stripe.Event,
): Notice {
  const subscription = event.data.object as Stripe.Subscription;
  const deleted = event.type === "customer.subscription.deleted";

  return {
    title: `${deleted ? "⏹️" : "🔄"} ${site.label} · 订阅${deleted ? "结束" : "变更"}`,
    template: deleted ? "orange" : "blue",
    fields: eventFields(event, [
      { label: "客户", value: formatCustomer(subscription.customer) },
      { label: "状态", value: subscription.status },
      { label: "事件类型", value: event.type },
    ]),
  };
}

function formatChargeRefunded(site: SiteConfig, event: Stripe.Event): Notice {
  const charge = event.data.object as Stripe.Charge;

  return {
    title: `↩️ ${site.label} · 退款`,
    template: "orange",
    fields: eventFields(event, [
      {
        label: "退款金额",
        value: formatDisplayAmount(charge.amount_refunded, charge.currency),
      },
      customerField(
        charge.billing_details.email,
        formatCustomer(charge.customer),
      ),
      {
        label: "账单国家",
        value: formatCountry(charge.billing_details.address?.country),
      },
    ]),
  };
}

function formatPaymentNotice(
  site: SiteConfig,
  event: Stripe.Event,
  payment: PaymentDetails,
): Notice {
  return {
    title: `💰 ${site.label} · 新${payment.kind}`,
    template: "green",
    fields: eventFields(event, [
      {
        label: "金额",
        value: formatDisplayAmount(payment.amount, payment.currency),
      },
      customerField(payment.email, payment.customer),
      { label: "来源国家", value: formatCountry(payment.originCountry) },
      { label: "账单国家", value: formatCountry(payment.country) },
      { label: "类型", value: payment.kind },
    ]),
  };
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

  if (
    value.includes("credit") ||
    value.includes("pack") ||
    value.includes("积分")
  )
    return "积分包";
  if (
    value.includes("year") ||
    value.includes("annual") ||
    value.includes("年")
  )
    return "年费";
  if (
    value.includes("month") ||
    value.includes("monthly") ||
    value.includes("月")
  )
    return "月费";
  return null;
}

function readMetadataCountry(metadata: Stripe.Metadata | null): string | null {
  return metadata?.origin_country ?? null;
}

function readInvoiceOriginCountry(invoice: Stripe.Invoice): string | null {
  return (
    findFirstString(invoice as unknown as Record<string, unknown>, [
      ["metadata", "origin_country"],
      ["subscription_details", "metadata", "origin_country"],
      ["parent", "subscription_details", "metadata", "origin_country"],
    ]) ?? null
  );
}

function readRecurringInterval(
  line: Stripe.InvoiceLineItem,
): string | undefined {
  const value = line as unknown as Record<string, unknown>;
  return findFirstString(value, [
    ["pricing", "price_details", "recurring", "interval"],
    ["price", "recurring", "interval"],
    ["plan", "interval"],
  ]);
}

function findFirstString(
  value: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    const found = findString(value, path);
    if (found) return found;
  }

  return undefined;
}

function findString(
  value: Record<string, unknown>,
  path: string[],
): string | undefined {
  let cursor: unknown = value;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return typeof cursor === "string" ? cursor : undefined;
}

function eventFields(
  event: Stripe.Event,
  fields: Array<{ label: string; value?: string | null }>,
): Notice["fields"] {
  return [
    ...fields,
    { label: "环境", value: event.livemode ? "正式" : "测试" },
    { label: "时间", value: formatUnix(event.created) },
    { label: "事件", value: event.id },
  ];
}

function customerField(
  email?: string | null,
  customer?: string | null,
): Notice["fields"][number] {
  return email
    ? { label: "邮箱", value: email }
    : { label: "客户", value: customer };
}

function formatDisplayAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount == null) return null;
  if (!currency) return String(amount);

  const code = currency.toUpperCase();
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    });
    const fractionDigits =
      formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount / 10 ** fractionDigits);
  } catch {
    return `${amount} ${code}`;
  }
}

function formatCustomer(
  customer:
    string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (!customer) return null;
  if (typeof customer === "string") return customer;
  if ("email" in customer && customer.email) return customer.email;
  return customer.id;
}

function formatUnix(seconds: number): string {
  const shanghaiSeconds = seconds + 8 * 60 * 60;
  return `${new Date(shanghaiSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")} GMT+8`;
}

function formatCountry(country: string | null | undefined): string | null {
  if (!country) return null;

  const code = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return code;

  const flag = [...code]
    .map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0)))
    .join("");
  return `${flag} ${code}`;
}

function buildFeishuCard(notice: Notice) {
  const content = notice.fields
    .filter((field): field is { label: string; value: string } =>
      Boolean(field.value),
    )
    .map((field) => `**${field.label}**　${escapeCardText(field.value)}`)
    .join("\n");

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: notice.title },
      template: notice.template,
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{ tag: "markdown", content }],
    },
  };
}

function escapeCardText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]~])/g, "\\$1");
}

async function sendFeishu(env: Env, notice: Notice): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    timestamp,
    sign: await feishuSign(timestamp, env.FEISHU_BOT_SECRET),
    msg_type: "interactive",
    card: buildFeishuCard(notice),
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

  console.log(
    "feishu_delivered",
    JSON.stringify({ status: response.status, body }),
  );
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
