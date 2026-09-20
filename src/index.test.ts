/**
 * [INPUT]: 依赖 node:test、node:assert/strict 与 formatEvent 的纯 Stripe 事件格式化合同
 * [OUTPUT]: 验证 Checkout/Invoice 注册归因、compact metadata、旧事件兼容、非法日期与未付款订阅过期过滤
 * [POS]: src 的 Worker 纯行为回归测试，不发送飞书请求、不读取 secret
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import assert from "node:assert/strict";
import test from "node:test";

import type Stripe from "stripe";

import { formatEvent } from "./index.ts";

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

function fieldValue(
  notice: ReturnType<typeof formatEvent>,
  label: string,
) {
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

  assert.equal(fieldValue(notice, "注册时间"), "2026-09-01 08:00:00 GMT+8");
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
  assert.equal(notice?.title, "💰 Motiofy AI · 新积分包");
  assert.equal(fieldValue(notice, "注册时间"), null);
  assert.equal(fieldValue(notice, "首次来源"), null);
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
