import { Button, Input, InputNumber } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { SelectField } from "./SelectField";
import { presetProducts } from "./products";
import { MAX_ITEMS } from "./items";
import type { PresetItem } from "./types";

export function ProductSelect({
  sku,
  onChange,
  label = "预制商品",
  disabled,
}: {
  sku: string;
  onChange: (sku: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const known = presetProducts.some((p) => p.sku === sku.replace(/\/A$/i, ""));
  return (
    <SelectField
      label={label}
      value={known ? sku.replace(/\/A$/i, "") : ""}
      placeholder="自定义 SKU"
      disabled={disabled}
      onChange={onChange}
      options={[
        { value: "", label: "自定义 SKU" },
        ...presetProducts.map((p) => ({
          value: p.sku,
          label: `${p.name} · ${p.sku}`,
        })),
      ]}
    />
  );
}

// 多商品编辑：每行一个 SKU + 数量，可增删；下单时整袋一起结账。
export function ItemRows({
  items,
  onChange,
  disabled,
}: {
  items: PresetItem[];
  onChange: (items: PresetItem[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<PresetItem>) =>
    onChange(
      items.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    );
  const suffix = (index: number) => (index === 0 ? "" : ` ${index + 1}`);
  return (
    <div className="item-rows">
      {items.map((item, index) => (
        <div className="item-row" key={index}>
          <ProductSelect
            label={`预制商品${suffix(index)}`}
            sku={item.sku}
            disabled={disabled}
            onChange={(sku) => update(index, { sku })}
          />
          <label>
            商品 SKU{suffix(index)}
            <Input
              required
              disabled={disabled}
              value={item.sku}
              placeholder="MJTA4CH"
              onChange={(e) =>
                update(index, { sku: e.target.value.toUpperCase() })
              }
            />
          </label>
          <label>
            数量{suffix(index)}
            <InputNumber
              required
              min={1}
              max={999}
              disabled={disabled}
              value={item.quantity}
              onChange={(value) =>
                update(index, { quantity: Number(value) || 0 })
              }
            />
          </label>
          <Button
            className="item-remove"
            aria-label={`移除商品${suffix(index)}`}
            icon={<Trash2 />}
            disabled={disabled || items.length <= 1}
            onClick={() => onChange(items.filter((_, at) => at !== index))}
          />
        </div>
      ))}
      <Button
        className="item-add"
        icon={<Plus />}
        disabled={disabled || items.length >= MAX_ITEMS}
        onClick={() => onChange([...items, { sku: "", quantity: 1 }])}
      >
        添加商品（最多 {MAX_ITEMS} 种）
      </Button>
    </div>
  );
}
