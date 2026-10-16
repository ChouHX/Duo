import type { Account, PresetItem } from "./types";

export const DEFAULT_SKU = "MK2U4CH";
export const DEFAULT_QUANTITY = 2;
export const MAX_ITEMS = 10;

// 账号自己的预设商品（没有就退回镜像字段；都没有就是空）。
export function ownItems(account?: Partial<Account> | null): PresetItem[] {
  const list = Array.isArray(account?.preset_items)
    ? account!.preset_items!
    : [];
  const clean = list
    .filter((item) => item && typeof item.sku === "string" && item.sku.trim())
    .map((item) => ({
      sku: String(item.sku).trim().toUpperCase(),
      quantity: Number(item.quantity) || 1,
    }));
  if (clean.length) return clean;
  if (account?.preset_sku)
    return [
      {
        sku: account.preset_sku,
        quantity: account.preset_quantity ?? DEFAULT_QUANTITY,
      },
    ];
  return [];
}

// 下单表单的默认值：账号预设 → 通用预设 → 内置默认。
export function presetItems(
  account?: Partial<Account> | null,
  fallback?: Partial<Account> | null,
): PresetItem[] {
  const own = ownItems(account);
  if (own.length) return own;
  const inherited = ownItems(fallback);
  if (inherited.length) return inherited;
  return [{ sku: DEFAULT_SKU, quantity: DEFAULT_QUANTITY }];
}

export function itemsValid(items: PresetItem[]) {
  return (
    items.length > 0 &&
    items.length <= MAX_ITEMS &&
    items.every(
      (item) =>
        item.sku.trim().length >= 7 &&
        item.sku.trim().length <= 30 &&
        Number.isInteger(item.quantity) &&
        item.quantity >= 1 &&
        item.quantity <= 999,
    )
  );
}

export function itemsText(items: PresetItem[]) {
  return items.map((item) => `${item.sku} × ${item.quantity}`).join("、");
}

export function itemsFromPreset(account?: Partial<Account> | null) {
  const own = ownItems(account);
  return own.length ? itemsText(own) : "—";
}

// 商品页点选：替换第一行，或追加一行为该 SKU。
export function withSku(items: PresetItem[], sku: string): PresetItem[] {
  const next = items.length ? [...items] : [];
  if (!next.length) return [{ sku, quantity: DEFAULT_QUANTITY }];
  if (!next.some((item) => item.sku === sku)) {
    if (next.length === 1 && !next[0].sku.trim()) next[0] = { ...next[0], sku };
    else if (next.length < MAX_ITEMS) next.push({ sku, quantity: 1 });
    else next[0] = { ...next[0], sku };
  }
  return next;
}
