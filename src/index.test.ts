/**
 * [INPUT]: 依赖 node:test、node:assert/strict 与 formatEvent 的Stripe/Waffo 事件合同、测试/正式群隔离与临时 RSA 测试密钥
 * [OUTPUT]: 验证金额标题、国家中文名、北京时间显示、归因兼容、平台验签、环境隔离与飞书投递失败传播
 * [POS]: src 的 Worker 纯行为回归测试，不发送飞书请求、不读取 secret
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import assert from "node:assert/strict";
import test from "node:test";

import type Stripe from "stripe";

import worker, { formatEvent, formatWaffoEvent } from "./index.ts";
import { generateKeyPairSync, sign, createHmac } from "node:crypto";

const site = {
  slug: "motiofy",
  label: "Motiofy AI",
  stripeWebhookSecret: "unused",
};

function checkoutEvent(metadata: Stripe.Metadata | null): Stripe.Event {
  return {
    id: "evt_checkout",
    type: "checkout.session.completed",
    created: 1_789_396_485,
    livemode: true,
    data: {
      object: {
        mode: "payment",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        metadata,
        customer_details: { email: "buyer@example.com", address: null },
      },
    },
  } as unknown as Stripe.Event;
}

function fieldValue(notice: ReturnType<typeof formatEvent>, label: string) {
  return notice?.fields.find((field) => field.label === label)?.value;
}

test("checkout renders standard registration and first-touch metadata", () => {
  const notice = formatEvent(
    site,
    checkoutEvent({
      signup_at: "2026-09-01T00:00:00.000Z",
      first_touch_source: "google",
      first_touch_medium: "organic",
      first_touch_campaign: "launch",
    }),
  );

  assert.deepEqual(notice?.fields.slice(0, 4).map(field => field.label), ["邮箱", "类型", "注册时间", "出单时间"]);
  assert.equal(fieldValue(notice, "类型"), "积分包");
  assert.equal(fieldValue(notice, "注册时间"), "2026-09-01 08:00:00");
  assert.equal(fieldValue(notice, "首次来源"), "google / organic");
  assert.equal(fieldValue(notice, "来源活动"), "launch");
});

test("checkout accepts compact Build Visuals attribution and omits bad dates", () => {
  const notice = formatEvent(
    site,
    checkoutEvent({ signup_at: "invalid", src: "directory", med: "referral" }),
  );

  assert.equal(fieldValue(notice, "注册时间"), null);
  assert.equal(fieldValue(notice, "首次来源"), "directory / referral");
});

test("legacy checkout without attribution remains a valid payment notice", () => {
  const notice = formatEvent(site, checkoutEvent(null));
  assert.equal(notice?.title, "💰 出单啦！$5.00 USD · Motiofy AI");
  assert.equal(fieldValue(notice, "注册时间"), null);
  assert.equal(fieldValue(notice, "首次来源"), null);
});

test("payment titles preserve zero-decimal currencies and omit unlabelled amounts", () => {
  const event = checkoutEvent(null);
  const session = event.data.object as Stripe.Checkout.Session;
  session.amount_total = 500;
  session.currency = "jpy";
  assert.equal(formatEvent(site, event)?.title, "💰 出单啦！¥500 JPY · Motiofy AI");
  session.currency = null;
  assert.equal(formatEvent(site, event)?.title, "💰 出单啦！Motiofy AI");
});

test("invoice reads current parent subscription metadata snapshot", () => {
  const event = {
    id: "evt_invoice",
    type: "invoice.payment_succeeded",
    created: 1_789_396_485,
    livemode: true,
    data: {
      object: {
        billing_reason: "subscription_cycle",
        amount_paid: 1_299,
        currency: "usd",
        metadata: {},
        parent: {
          subscription_details: {
            metadata: {
              signup_at: "2026-09-01T00:00:00.000Z",
              first_touch_source: "newsletter",
              first_touch_medium: "email",
            },
          },
        },
        lines: { data: [] },
      },
    },
  } as unknown as Stripe.Event;

  const notice = formatEvent(site, event);
  assert.equal(fieldValue(notice, "首次来源"), "newsletter / email");
});

test("unpaid incomplete subscription expiration is ignored", () => {
  const event = {
    id: "evt_expired",
    type: "customer.subscription.updated",
    created: 1_789_817_181,
    livemode: true,
    data: {
      previous_attributes: { status: "incomplete" },
      object: {
        status: "incomplete_expired",
        customer: "cus_test",
      },
    },
  } as unknown as Stripe.Event;

  assert.equal(formatEvent(site, event), null);
});

const storeId = "STO_6UnVcck9q54NexgyLmWssn";
function waffoEvent() {
  return {
    id: "PAY_fixture",
    timestamp: "2026-10-09T02:00:00.000Z",
    eventType: "order.completed",
    eventId: "PAY_fixture",
    storeId,
    storeName: "Build Visuals",
    mode: "prod",
    data: {
      orderId: "ORD_fixture",
      buyerEmail: "test@example.com",
      currency: "USD",
      chargedAmount: "9.00",
      amount: "9.00",
      taxAmount: "0.00",
      productName: "Mini Pack",
      billingDetail: { country: "CN" },
      orderMerchantExternalId: "local1",
      orderMetadata: {
        signup_at: "2026-10-01T00:00:00Z",
        first_touch_source: "google",
        origin_country: "US",
      },
    },
  } as any;
}

test("Waffo formats display amounts, ISO dates and attribution without Stripe cent conversion", () => {
  const notice = formatWaffoEvent(waffoEvent());
  assert.equal(notice?.title, "💰 出单啦！$9.00 USD · Build Visuals");
  assert.equal(fieldValue(notice, "支付渠道"), "Waffo");
  assert.equal(fieldValue(notice, "账单国家"), "🇨🇳 CN 中国");
  assert.equal(fieldValue(notice, "来源国家"), "🇺🇸 US 美国");
  assert.equal(fieldValue(notice, "首次来源"), "google");
  assert.equal(fieldValue(notice, "出单时间"), "2026-10-09 10:00:00");
});

test("Waffo skips other event types and does not fabricate missing charged amounts", () => {
  assert.equal(
    formatWaffoEvent({ ...waffoEvent(), eventType: "refund.succeeded" }),
    null,
  );
  const event = waffoEvent();
  delete event.data.chargedAmount;
  delete event.data.orderMetadata;
  const notice = formatWaffoEvent({ ...event, mode: "test" });
  assert.doesNotMatch(notice!.title, /9\.00|USD/);
  assert.equal(fieldValue(notice, "首次来源"), null);
  assert.match(notice!.title, /测试/);
});

test("Waffo route verifies raw signatures, environment and store before delivering", async (t) => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const previous = process.env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY;
  process.env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY = keys.publicKey;
  t.after(() => {
    if (previous === undefined)
      delete process.env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY;
    else process.env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY = previous;
  });
  const sent: any[] = [];
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ code: 0 });
    },
  );
  const env = {
    WAFFO_ENVIRONMENT: "prod",
    FEISHU_WEBHOOK_URL: "https://example.invalid/test-bot",
    FEISHU_BOT_SECRET: "test-only-fixture",
  } as any;
  const path = "https://example.invalid/buildvisuals/waffo/webhook";
  const request = (event: any, timestamp = Date.now()) => {
    const body = JSON.stringify(event);
    const sig = sign(
      "RSA-SHA256",
      Buffer.from(`${timestamp}.${body}`),
      keys.privateKey,
    ).toString("base64");
    return new Request(path, {
      method: "POST",
      body,
      headers: { "x-waffo-signature": `t=${timestamp},v1=${sig}` },
    });
  };
  for (const req of [
    new Request(path, { method: "POST" }),
    request({ ...waffoEvent(), mode: "test" }),
    request({ ...waffoEvent(), storeId: "STO_other" }),
    request(waffoEvent(), Date.now() - 46 * 60 * 1000),
    new Request(path, {
      method: "POST",
      body: "{}",
      headers: { "x-waffo-signature": "t=0,v1=invalid" },
    }),
  ]) {
    assert.equal((await worker.fetch(req, env)).status, 400);
  }
  assert.equal(sent.length, 0);
  assert.equal((await worker.fetch(new Request(path), env)).status, 405);
  assert.equal(
    (
      await worker.fetch(
        request({ ...waffoEvent(), eventType: "subscription.activated" }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(sent.length, 0);
  assert.equal((await worker.fetch(request(waffoEvent()), env)).status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].card.header.title.content, /\$9\.00 USD/);
  assert.match(sent[0].card.body.elements[0].content, /注册时间[^\n]*\n\*\*出单时间/);
  assert.doesNotMatch(sent[0].card.body.elements[0].content, /PAY_fixture|local1/);
  assert.match(sent[0].card.body.elements[1].content, /local1[\s\S]*PAY\\_fixture/);
  fetchMock.mock.mockImplementation(async () => Response.json({ code: 19024 }));
  await assert.rejects(
    worker.fetch(request(waffoEvent()), env),
    /Feishu webhook rejected/,
  );
  fetchMock.mock.mockImplementation(
    async () => new Response("unavailable", { status: 503 }),
  );
  await assert.rejects(
    worker.fetch(request(waffoEvent()), env),
    /Feishu webhook failed/,
  );
});

test("Stripe checkout still verifies HMAC and shares the existing Feishu sender", async (t) => {
  let deliveries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    deliveries++;
    return Response.json({ StatusCode: 0 });
  });
  const env = {
    BUILDVISUALS_STRIPE_WEBHOOK_SECRET: "test-only-signing-fixture",
    FEISHU_WEBHOOK_URL: "https://example.invalid/bot",
    FEISHU_BOT_SECRET: "test-only-bot-fixture",
  } as any;
  const body = JSON.stringify(checkoutEvent(null));
  const stamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", env.BUILDVISUALS_STRIPE_WEBHOOK_SECRET)
    .update(`${stamp}.${body}`)
    .digest("hex");
  const response = await worker.fetch(
    new Request("https://example.invalid/buildvisuals/stripe/webhook", {
      method: "POST",
      body,
      headers: { "stripe-signature": `t=${stamp},v1=${signature}` },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(deliveries, 1);
});


test("verified Stripe modes use isolated bots without fallback", async (t) => {
  const sent: Array<{ url: string; payload: any }> = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    sent.push({ url: String(url), payload: JSON.parse(init.body) });
    return Response.json({ code: 0 });
  });
  const env = {
    ZOMBIECOUPLEVID_STRIPE_WEBHOOK_SECRET: "fixture-signing",
    FEISHU_WEBHOOK_URL: "https://example.invalid/live",
    FEISHU_BOT_SECRET: "fixture-live",
    FEISHU_TEST_WEBHOOK_URL: "https://example.invalid/test",
    FEISHU_TEST_BOT_SECRET: "fixture-test",
  } as any;
  const request = (live: any) => {
    const body = JSON.stringify({ ...checkoutEvent(null), livemode: live });
    const stamp = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", env.ZOMBIECOUPLEVID_STRIPE_WEBHOOK_SECRET)
      .update(`${stamp}.${body}`).digest("hex");
    return new Request("https://example.invalid/zombiecouplevid/stripe/webhook", {
      method: "POST", body,
      headers: { "stripe-signature": `t=${stamp},v1=${sig}` },
    });
  };
  for (const live of [false, true]) {
    assert.equal((await worker.fetch(request(live), env)).status, 200);
  }
  assert.deepEqual(sent.map(x => x.url), [env.FEISHU_TEST_WEBHOOK_URL, env.FEISHU_WEBHOOK_URL]);
  assert.match(JSON.stringify(sent[0].payload.card), /🧪 测试/);
  for (const [index, secret] of [env.FEISHU_TEST_BOT_SECRET, env.FEISHU_BOT_SECRET].entries()) {
    assert.equal(sent[index].payload.sign, createHmac("sha256", `${sent[index].payload.timestamp}\n${secret}`).update("").digest("base64"));
  }
  await assert.rejects(worker.fetch(request(false), { ...env, FEISHU_TEST_WEBHOOK_URL: undefined }), /Missing Feishu test configuration/);
  await assert.rejects(worker.fetch(request(true), { ...env, FEISHU_WEBHOOK_URL: undefined }), /Missing Feishu live configuration/);
  await assert.rejects(worker.fetch(request(undefined), env), /Missing event environment/);
  assert.equal(sent.length, 2);
});
