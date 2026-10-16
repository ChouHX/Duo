import { useEffect, useId, useState } from "react";
import { Alert, Button, Checkbox, Input, Typography } from "antd";
import { Section } from "./Section";
import { MapPin } from "lucide-react";
import { SelectField, type Option } from "./SelectField";
import { InfoTip } from "./InfoTip";
import { LOCAL_ID, type Account, type Action, type Data } from "./types";

const contactFields = [
  ["lastName", "姓氏", "例如：张", "family-name"],
  ["firstName", "名字", "例如：三", "given-name"],
  ["emailAddress", "通知邮箱", "例如：name@example.com", "email"],
  ["fullDaytimePhone", "手机号", "收件人的手机号码", "tel-national"],
] as const;

export function AddressForm({
  account,
  busy,
  result,
  prefill,
  prefillId,
  regionNote,
  states,
  regionOptions,
  loadRegionOptions,
  start,
  startGeneral,
}: {
  account: Account;
  busy: boolean;
  result?: Data;
  prefill?: Data;
  prefillId?: string;
  regionNote?: string;
  states: Option[];
  regionOptions: Record<string, Option[]>;
  loadRegionOptions: (params: Data) => Promise<void>;
  start: (action: Action, params?: Data) => Promise<void>;
  startGeneral?: (action: Action, params?: Data) => Promise<void>;
}) {
  const streetId = useId();
  const [form, setForm] = useState<Data>({
    contact: { emailAddress: account.email },
    delivery: {},
    address: {},
  });
  const [error, setError] = useState("");
  // 保存时顺带把同一份配置写进"通用预设"（新账号默认值）。
  const [alsoGeneral, setAlsoGeneral] = useState(false);
  // 省 / 市 / 区级联走官网 address-lookup，不需要登录会话；“读取官网地区”才需要账号。
  const canReadRegion = account.id !== LOCAL_ID && !account.pending;
  const loaded = Boolean(result?.config);
  useEffect(() => {
    // 已有读取结果时不再重复下发，避免从任务指示器回到本页时又冒出新的任务。
    if (!loaded) start("address_read");
  }, [account.id, loaded]);
  const savedConfig = JSON.stringify(result?.config);
  useEffect(() => {
    if (result?.config)
      setForm((f) => ({
        contact: { emailAddress: account.email, ...result.config.contact },
        // 配置里的省 / 市 / 区优先（"填入通用预设"要能改掉旧地区）；
        // 配置里没有地区时才保留当前选择。
        delivery: Object.keys(result.config.delivery || {}).length
          ? result.config.delivery
          : f.delivery,
        address: result.config.address || {},
      }));
  }, [savedConfig, account.email]);
  const savedPrefill = JSON.stringify(prefill);
  const setContact = (key: string, value: string) =>
    setForm((f) => ({ ...f, contact: { ...f.contact, [key]: value } }));
  const setDelivery = (patch: Data) =>
    setForm((f) => ({ ...f, delivery: { ...f.delivery, ...patch } }));
  useEffect(() => {
    if (!prefill) return;
    setForm((f) => ({
      contact: { ...f.contact, ...(prefill.contact || {}) },
      delivery: { ...f.delivery, ...(prefill.region || {}) },
      address: { ...f.address, ...(prefill.address || {}) },
    }));
  }, [prefillId, savedPrefill]);
  const delivery = form.delivery || {};
  const cities = regionOptions[`city|${delivery.state || ""}`] || [];
  const districts =
    regionOptions[`district|${delivery.state || ""}|${delivery.city || ""}`] ||
    [];
  useEffect(() => {
    if (!states.length) void loadRegionOptions({ level: "state" });
  }, [states.length]);
  useEffect(() => {
    if (delivery.state)
      void loadRegionOptions({ level: "city", state: delivery.state });
  }, [delivery.state]);
  useEffect(() => {
    if (delivery.state && delivery.city)
      void loadRegionOptions({
        level: "district",
        state: delivery.state,
        city: delivery.city,
      });
  }, [delivery.state, delivery.city]);
  useEffect(() => {
    if (
      delivery.state &&
      cities.length === 1 &&
      delivery.city !== cities[0].value
    )
      setDelivery({ city: cities[0].value, district: "" });
  }, [delivery.state, cities.length]);
  return (
    <Section
      className="section address-card"
      title="快捷送货地址"
      info={
        <InfoTip label="快捷送货地址说明">
          {account.id === LOCAL_ID
            ? "新账号将继承此地址，已有账号不会被覆盖。"
            : "保存为此账号的本机预设。"}
          下单时直接使用这份快捷地址，全程全自动（不再询问配送方式与地址来源）。
          {canReadRegion &&
            "“读取官网地区”会填入该账号官网的默认收货地址和省 / 市 / 区；仍可修改，并需点击“保存地址预设”才会保存在本机。"}
        </InfoTip>
      }
      extra={
        canReadRegion && (
          <Button
            icon={<MapPin />}
            disabled={busy}
            onClick={() => start("region")}
          >
            读取官网地区
          </Button>
        )
      }
    >
      {regionNote && (
        <Typography.Paragraph className="address-guidance">
          {regionNote}
        </Typography.Paragraph>
      )}
      {result?.inherited && (
        <Typography.Paragraph className="address-guidance">
          此账号尚未单独保存地址，上方显示的是通用预设；点击“保存地址预设”后会单独保存为此账号。
        </Typography.Paragraph>
      )}
      <Typography.Paragraph className="address-guidance">
        {result?.config?.address?.street
          ? "已预填保存的地址，可直接修改。修改后点击“保存地址预设”。"
          : "填写收件人和送货地点；输入框中的示例仅作提示，所有项目均需填写。"}
      </Typography.Paragraph>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!delivery.state || !delivery.city || !delivery.district) {
            setError("请选择省 / 直辖市、城市和区 / 县。");
            return;
          }
          setError("");
          void (async () => {
            await start("address_save", form);
            if (alsoGeneral && startGeneral) {
              try {
                await startGeneral("address_save", form);
              } catch (e) {
                setError(`已保存到此账号，但写入通用预设失败：${String(e)}`);
              }
            }
          })();
        }}
      >
        <div className="address-fields">
          {contactFields.map(([key, label, placeholder, autoComplete]) => (
            <label key={key}>
              {label}
              <Input
                required
                disabled={busy}
                type={
                  key === "emailAddress"
                    ? "email"
                    : key === "fullDaytimePhone"
                      ? "tel"
                      : "text"
                }
                value={form.contact?.[key] || ""}
                placeholder={placeholder}
                autoComplete={`shipping ${autoComplete}`}
                onChange={(e) => setContact(key, e.target.value)}
              />
            </label>
          ))}
          <SelectField
            label="省 / 直辖市"
            value={delivery.state || ""}
            options={states}
            disabled={busy}
            required
            placeholder="请选择"
            onChange={(value) =>
              setDelivery({ state: value, city: "", district: "" })
            }
          />
          <SelectField
            label="城市"
            value={delivery.city || ""}
            options={cities}
            disabled={busy || !delivery.state}
            required
            placeholder={delivery.state ? "加载中…" : "请先选择省 / 直辖市"}
            onChange={(value) => setDelivery({ city: value, district: "" })}
          />
          <SelectField
            label="区 / 县"
            value={delivery.district || ""}
            options={districts}
            disabled={busy || !delivery.city}
            required
            placeholder={delivery.city ? "加载中…" : "请先选择城市"}
            onChange={(value) => setDelivery({ district: value })}
          />
          <div className="wide">
            <label htmlFor={streetId}>详细地址</label>
            <p id={`${streetId}-hint`} className="address-guidance">
              从街道开始填写，写清小区、楼栋、单元和门牌号。省市区填在上方即可。
            </p>
            <Input.TextArea
              id={streetId}
              aria-describedby={`${streetId}-hint`}
              required
              disabled={busy}
              rows={2}
              autoComplete="shipping street-address"
              placeholder="例如：中山路 88 号，阳光花园 3 栋 2 单元 601 室"
              value={form.address?.street || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  address: { ...f.address, street: e.target.value },
                }))
              }
            />
          </div>
        </div>
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            style={{ marginBottom: 12 }}
          />
        )}
        <div className="form-actions form-actions-column">
          {startGeneral && (
            <Checkbox
              disabled={busy}
              checked={alsoGeneral}
              onChange={(e) => setAlsoGeneral(e.target.checked)}
            >
              同时写入通用预设（新账号默认继承）
            </Checkbox>
          )}
          <Button type="primary" htmlType="submit" disabled={busy}>
            保存地址预设
          </Button>
        </div>
      </form>
    </Section>
  );
}
