/**
 * [INPUT]: 各站独立 Stripe 签名密钥、飞书环境绑定及付款卡片配置类型。
 * [OUTPUT]: Env、SiteConfig 类型及通知路由表。
 * [POS]: Worker 的站点边界；各路由只绑定本站签名密钥；本站可临时转测试群。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { PaymentCardConfig } from "./cards.ts";

export type Env = {
  WAFFO_ENVIRONMENT?: "test" | "prod";
  ERASIO_STRIPE_WEBHOOK_SECRET: string;
  PLAYITOUT_STRIPE_WEBHOOK_SECRET: string;
  MOTIOFY_STRIPE_WEBHOOK_SECRET: string;
  BUILDVISUALS_STRIPE_WEBHOOK_SECRET: string;
  ZOMBIECOUPLEVID_STRIPE_WEBHOOK_SECRET: string;
  HITTHEROADDUDE_STRIPE_WEBHOOK_SECRET: string;
  RAPPERMAKER_STRIPE_WEBHOOK_SECRET: string;
  OURLITTLESONG_STRIPE_WEBHOOK_SECRET: string;
  FEISHU_WEBHOOK_URL: string;
  FEISHU_BOT_SECRET: string;
  FEISHU_TEST_WEBHOOK_URL?: string;
  FEISHU_TEST_BOT_SECRET?: string;
};

export type SiteConfig = {
  slug: string;
  label: string;
  stripeWebhookSecret: string;
  paymentCard?: PaymentCardConfig;
  forceTestNotifications?: boolean;
};

type StripeWebhookSecretName = Extract<
  keyof Env,
  `${string}_STRIPE_WEBHOOK_SECRET`
>;

type SiteDefinition = Omit<SiteConfig, "stripeWebhookSecret"> & {
  stripeWebhookSecretName: StripeWebhookSecretName;
};

export const sites: Record<string, SiteDefinition> = {
  "/rappermaker/stripe/webhook": {
    slug: "rappermaker",
    label: "RapperMaker",
    stripeWebhookSecretName: "RAPPERMAKER_STRIPE_WEBHOOK_SECRET",
  },
  "/ourlittlesong/stripe/webhook": {
    slug: "ourlittlesong",
    label: "OurLittleSong",
    stripeWebhookSecretName: "OURLITTLESONG_STRIPE_WEBHOOK_SECRET",
  },
  "/hittheroaddude/stripe/webhook": {
    slug: "hittheroaddude",
    label: "HitTheRoadDude",
    stripeWebhookSecretName: "HITTHEROADDUDE_STRIPE_WEBHOOK_SECRET",
  },
  "/zombiecouplevid/stripe/webhook": {
    slug: "zombiecouplevid",
    label: "ZombieCoupleVid",
    stripeWebhookSecretName: "ZOMBIECOUPLEVID_STRIPE_WEBHOOK_SECRET",
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
  "/motiofy/stripe/webhook": {
    slug: "motiofy",
    label: "Motiofy AI",
    stripeWebhookSecretName: "MOTIOFY_STRIPE_WEBHOOK_SECRET",
  },
  "/buildvisuals/stripe/webhook": {
    slug: "buildvisuals",
    label: "Build Visuals",
    stripeWebhookSecretName: "BUILDVISUALS_STRIPE_WEBHOOK_SECRET",
  },
};
