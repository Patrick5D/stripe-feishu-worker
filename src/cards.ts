/**
 * [INPUT]: 事件适配器生成的通知及站点可选付款卡片配置。
 * [OUTPUT]: 通知类型、付款字段标识与 applyPaymentCard 纯函数。
 * [POS]: 卡片展示边界；只重排和命名现有字段，不生成支付事实。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export type PaymentField =
  | "customer" | "kind" | "product" | "signupAt" | "paidAt"
  | "source" | "campaign" | "originCountry" | "billingCountry"
  | "order" | "paymentIntent" | "extraRequest" | "channel" | "environment" | "event";

export type Notice = {
  title: string;
  template: "green" | "red" | "orange" | "blue";
  fields: Array<{
    id?: PaymentField;
    label: string;
    value?: string | null;
    secondary?: boolean;
  }>;
};

export type PaymentCardConfig = {
  /** 替换“出单啦！”，金额、币种和站点名仍由事件生成。 */
  headline?: string;
  color?: Notice["template"];
  /** 指定字段优先排列；其余字段保留原顺序，技术分区不变。 */
  fieldOrder?: readonly PaymentField[];
  hiddenFields?: readonly PaymentField[];
  labels?: Partial<Record<PaymentField, string>>;
};

export function applyPaymentCard(notice: Notice, config?: PaymentCardConfig): Notice {
  if (!config) return notice;
  const order = config.fieldOrder ?? [];
  const rank = (id?: PaymentField) => {
    const index = id ? order.indexOf(id) : -1;
    return index < 0 ? order.length : index;
  };
  return {
    ...notice,
    template: config.color ?? notice.template,
    fields: notice.fields
      .filter(field => !field.id || !config.hiddenFields?.includes(field.id))
      .map(field => ({ ...field, label: (field.id && config.labels?.[field.id]) ?? field.label }))
      .sort((a, b) => rank(a.id) - rank(b.id)),
  };
}
