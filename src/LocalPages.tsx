import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { Section } from "./Section";
import {
  ExternalLink,
  LayoutDashboard,
  Import,
  LoaderCircle,
  QrCode,
  RefreshCw,
  Settings2,
  Store,
  Truck,
} from "lucide-react";
import type { Bridge } from "./api";
import {
  active,
  LOCAL_ID,
  localDefaults,
  type Account,
  type Action,
  type Data,
  type PresetItem,
  type Snapshot,
  type Task,
} from "./types";
import { duoProducts, priceText } from "./products";
import { ItemRows } from "./ItemRows";
import { itemsText, ownItems, presetItems } from "./items";
import { useAccountPrivacy } from "./AccountPrivacy";
import { AddressForm } from "./AddressForm";
import { SelectField, type Option } from "./SelectField";
import { InfoTip } from "./InfoTip";

export type Route = "workspace" | "account" | "duo" | "pay";
const OFFICIAL_DUO_URL = "https://www.apple.com.cn/shop/buy-iphone/iphone-duo";
const readRoute = (): Route =>
  location.hash === "#/account"
    ? "account"
    : location.hash === "#/duo"
      ? "duo"
      : location.hash === "#/pay"
        ? "pay"
        : "workspace";
export function useRoute() {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return [
    route,
    (next: Route) => {
      location.hash = next === "workspace" ? "/" : `/${next}`;
      setRoute(next);
    },
  ] as const;
}
export function RouteNav({
  route,
  navigate,
  counts = {},
}: {
  route: Route;
  navigate: (route: Route) => void;
  /** 页面上的待处理数量（例如待付款的账号数）。 */
  counts?: Partial<Record<Route, number>>;
}) {
  return (
    <nav className="route-nav" aria-label="页面导航">
      {(
        [
          ["workspace", "账号工作台", <LayoutDashboard key="i" />],
          ["pay", "付款码", <QrCode key="i" />],
          ["duo", "DUO 状态", <Radio key="i" />],
        ] as const
      ).map(([id, label, Icon]) => (
        <a
          key={id}
          className={route === id ? "active" : ""}
          title={label}
          aria-label={label}
          href={id === "workspace" ? "#/" : `#/${id}`}
          aria-current={route === id ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(id);
          }}
        >
          {Icon}
          <span>{label}</span>
          {counts[id] ? (
            <span className="route-count">{counts[id]}</span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
export { ProductSelect } from "./ItemRows";
type PageProps = {
  snapshot: Snapshot;
  bridge: Bridge;
  refresh: () => Promise<void>;
};
type Store = {
  id: string;
  name: string;
  disabled?: boolean;
  city?: string;
  address?: string;
  availability?: { name?: string; quote?: string }[];
};
function StoreSection({
  busy,
  states,
  regionOptions,
  loadRegionOptions,
  storesTask,
  storesResult,
  delivery,
  preset,
  sku,
  start,
}: {
  busy: boolean;
  states: Option[];
  regionOptions: Record<string, Option[]>;
  loadRegionOptions: (params: Data) => Promise<void>;
  storesTask?: Task;
  storesResult?: Data;
  delivery?: Data;
  preset?: Data;
  /** 查询取货可用性用的 SKU：用账号实际要买的商品，否则会拿内置默认 SKU 算出错误结论。 */
  sku?: string;
  start: (action: Action, params?: Data) => Promise<void>;
}) {
  const [state, setState] = useState(
    String(preset?.state || delivery?.state || ""),
  );
  const [city, setCity] = useState(
    String(preset?.city || delivery?.city || ""),
  );
  const [district, setDistrict] = useState(String(preset?.district || ""));
  const [storeId, setStoreId] = useState("");
  const cities = regionOptions[`city|${state}`] || [];
  const districts = regionOptions[`district|${state}|${city}`] || [];
  const stores = (storesResult?.stores || []) as Store[];
  const latest = storesTask?.status === "succeeded" ? stores : undefined;
  useEffect(() => {
    if (state) void loadRegionOptions({ level: "city", state });
  }, [state]);
  useEffect(() => {
    if (state && city)
      void loadRegionOptions({ level: "district", state, city });
  }, [state, city]);
  // 地址预设读回后，取货地区默认跟随送货地区（两者通常一致）。
  useEffect(() => {
    if (!state && delivery?.state) setState(String(delivery.state));
  }, [delivery?.state]);
  useEffect(() => {
    if (!city && delivery?.city && String(delivery.state || "") === state)
      setCity(String(delivery.city));
  }, [delivery?.city, delivery?.state, state]);
  // 官网返回的门店全部列出（含当前不可取货的），只靠"可用"过滤会让界面在门店都无货时一片空白。
  const listed = stores.filter((s) => s.id);
  const available = listed.filter((s) => !s.disabled);
  const options = listed.map((s) => ({
    value: s.id,
    label:
      (s.name || s.id) +
      (s.disabled ? "（当前不可取货）" : "") +
      (s.availability?.length
        ? " · " +
          s.availability
            .map((a) => `${a.name || "商品"}：${a.quote || "未知"}`)
            .join("；")
        : ""),
  }));
  const picked = stores.find((s) => s.id === storeId);
  return (
    <Section
      className="section"
      title="自提门店"
      info={
        <InfoTip label="自提门店说明">
          选好“省 → 市”即可查询，区 / 县
          可选、填了更精确。保存后下单时由程序在官网返回的门店里
          **自动挑最近的、有货的那一家**，不会锁定某家门店，因此不会因为指定门店没货而失败。
          “查询附近门店”只用来预览该地区有哪些直营店与取货状态：走官网的购物袋门店定位器，
          所以购物袋里至少要有一件商品，可用性也是官网按该商品实时给的；不需要登录，
          取货联系人用上面的姓名、手机与邮箱。
        </InfoTip>
      }
    >
      {preset?.state ? (
        <Typography.Paragraph>
          已预设取货地区：
          {[preset.state, preset.city, preset.district]
            .filter(Boolean)
            .join(" ")}
          {preset.id
            ? `（旧配置指定的门店：${String(preset.name || preset.id)}）`
            : ""}
          。下单时自动选最近且有货的门店。{" "}
          <Button
            type="link"
            size="small"
            disabled={busy}
            onClick={() => start("store_save", { store: null })}
          >
            清除
          </Button>
        </Typography.Paragraph>
      ) : null}
      <div className="address-fields three">
        <SelectField
          label="取货省 / 直辖市"
          value={state}
          options={states}
          disabled={busy}
          onChange={(value) => {
            setState(value);
            setCity("");
            setDistrict("");
            setStoreId("");
          }}
        />
        <SelectField
          label="取货城市"
          value={city}
          options={cities}
          disabled={busy || !state}
          placeholder={state ? "请选择" : "请先选择取货省 / 直辖市"}
          onChange={(value) => {
            setCity(value);
            setDistrict("");
            setStoreId("");
          }}
        />
        <SelectField
          label="取货区 / 县"
          value={district}
          options={districts}
          disabled={busy || !city}
          placeholder={city ? "请选择" : "请先选择城市"}
          onChange={(value) => {
            setDistrict(value);
            setStoreId("");
          }}
        />
      </div>
      <div className="form-actions">
        <Button
          icon={<Radio />}
          disabled={busy || !city}
          onClick={() =>
            start("stores", { state, city, district, sku: sku || "" })
          }
        >
          查询附近门店
        </Button>
      </div>
      {storesTask?.status === "running" && (
        <Typography.Paragraph type="secondary" className="store-note">
          <Spin indicator={<LoaderCircle className="spin" />} size="small" />{" "}
          正在读取官网门店定位器…
        </Typography.Paragraph>
      )}
      {storesTask?.status === "failed" && (
        <Alert
          type="warning"
          showIcon
          title={
            storesTask.result?.message || storesTask.stage || "门店查询失败。"
          }
          description={
            String(storesTask.result?.message || "").includes("购物袋")
              ? "门店列表挂在购物袋的商品上：请先在“购物袋”页加入一件商品，再回来查询。"
              : "门店查询走本机 Chrome 读取官网门店定位器，请保持网络畅通；首次查询需要几秒钟。"
          }
        />
      )}
      {latest?.length === 0 && (
        <Alert
          type="info"
          showIcon
          title={`未在${[state, city, district].filter(Boolean).join(" ")}查到可自提门店。`}
          description="官网只返回有直营店且有取货信息的结果；可换一个区 / 县，或稍后重试（官网可能限流）。"
        />
      )}
      {Boolean(latest?.length) && available.length === 0 && (
        <Alert
          type="warning"
          showIcon
          title={`官网返回了 ${listed.length} 家门店，但当前商品都不可取货。`}
          description="可用性由官网按所选地区与商品实时返回；换一个该地区有货的商品再查一次，或改用快递配送。"
        />
      )}
      {options.length > 0 && (
        <Typography.Paragraph type="secondary" className="store-note">
          查到 {options.length} 家门店（其中 {available.length}{" "}
          家当前可取货）。可用性由官网按所选地区与商品实时返回
          {sku ? `（当前 SKU：${sku}）` : ""}
          ；下单时会自动挑最近且有货的那一家（列表顺序即官网就近排序）：
          {options.map((option) => option.label.split(" · ")[0]).join("、")}。
        </Typography.Paragraph>
      )}
      <div className="form-actions">
        <Button
          type="primary"
          disabled={busy || !district}
          onClick={() =>
            start("store_save", { store: { state, city, district } })
          }
        >
          保存取货地区
        </Button>
      </div>
    </Section>
  );
}
export function AccountSettings({
  snapshot,
  bridge,
  refresh,
  account,
  startGeneral,
}: PageProps & {
  account: Account;
  startGeneral?: (action: Action, params?: Data) => Promise<void>;
}) {
  const [requestId, setRequestId] = useState("");
  const tasks = snapshot.tasks.filter((t) => t.account_id === account.id);
  const recent = (actions: Action[]) =>
    tasks
      .filter((t) => actions.includes(t.action))
      .sort(
        (a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at,
      );
  const addressTasks = recent(["address_read", "address_save", "region"]);
  const requested = tasks.find((t) => t.id === requestId);
  // 配置来源：最近一次返回了 config 的任务（读取、保存地址、保存送货方式/门店、填入通用预设都算），
  // 这样"查询附近门店"这类没有 config 的任务不会把界面回退到旧配置。
  const result = (
    requested?.status === "succeeded" && requested.result?.config
      ? requested
      : tasks.find((t) => t.status === "succeeded" && t.result?.config)
  )?.result;
  const regionTask = recent(["region"]).find((t) => t.status === "succeeded");
  const regionNote =
    regionTask && (!requested || requested.updated_at <= regionTask.updated_at)
      ? regionTask.result?.message
      : undefined;
  const regionKey = (level: string, state?: string, city?: string) =>
    level === "state"
      ? "state"
      : level === "city"
        ? `city|${state || ""}`
        : `district|${state || ""}|${city || ""}`;
  const storesTask = recent(["stores"])[0];
  const storesResult = recent(["stores"]).find(
    (t) => t.status === "succeeded",
  )?.result;
  // 门店可用性按商品算：取账号实际下单用的 SKU（通用预设优先，和下单表单一致），
  // 不能靠后端的旧配置字段兜底——那里没有值时会退回内置 SKU，结论就完全错了。
  const globalDefaults = snapshot.accounts.find((a) => a.id === LOCAL_ID);
  const pickupSku = presetItems(
    ownItems(globalDefaults).length ? globalDefaults : account,
    globalDefaults,
  )[0]?.sku;
  const [regionOptions, setRegionOptions] = useState<Record<string, Option[]>>(
    () => {
      // 从快照里已有的 region / region_options 结果预热缓存，避免重新进入页面时重复查询。
      const cache: Record<string, Option[]> = {};
      for (const t of recent(["region_options"])) {
        const r = t.result;
        if (t.status !== "succeeded" || !r?.options?.length) continue;
        const key = regionKey(
          String(r.level || ""),
          String(r.state || ""),
          String(r.city || ""),
        );
        if (!cache[key]?.length) cache[key] = r.options;
      }
      const states = recent(["region"]).find((t) => t.status === "succeeded")
        ?.result?.states;
      if (states?.length) cache.state = states;
      return cache;
    },
  );
  const regionInFlight = useRef<Set<string>>(new Set());
  const optionTasks = tasks
    .filter(
      (t) =>
        t.action === "region_options" &&
        t.status === "succeeded" &&
        t.result?.level,
    )
    .map((t) => t.result!);
  const optionSignature = JSON.stringify(
    optionTasks.map((r) => [r.level, r.state, r.city, r.options?.length]),
  );
  useEffect(() => {
    setRegionOptions((cache) => {
      let next = cache;
      for (const r of optionTasks) {
        const key = regionKey(r.level, r.state, r.city);
        regionInFlight.current.delete(key);
        if (!next[key]?.length && r.options?.length)
          next = { ...next, [key]: r.options };
      }
      return next;
    });
  }, [optionSignature]);
  const savedStates = JSON.stringify(regionTask?.result?.states);
  useEffect(() => {
    const states = regionTask?.result?.states;
    if (states?.length)
      setRegionOptions((cache) =>
        cache.state?.length ? cache : { ...cache, state: states },
      );
  }, [savedStates, regionTask?.id]);
  const states = regionOptions.state || [];
  async function loadRegionOptions(params: Data) {
    const key = regionKey(params.level, params.state, params.city);
    if (regionOptions[key]?.length || regionInFlight.current.has(key)) return;
    regionInFlight.current.add(key);
    try {
      await bridge.start(account.id, "region_options", {
        level: params.level,
        state: params.state || "",
        city: params.city || "",
      });
      await refresh();
    } catch (e) {
      regionInFlight.current.delete(key);
      setError(String(e));
    }
  }
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState("");
  const savedMethod = result?.config?.delivery_method;
  // 下单方式就是全自动：不再提供开关，结账时不询问配送方式与地址来源。
  const [applecare, setApplecare] = useState(
    result?.config?.applecare === true,
  );
  useEffect(() => {
    setApplecare(result?.config?.applecare === true);
  }, [result?.config?.applecare, account.id]);
  const [method, setMethod] = useState<"delivery" | "pickup">(
    savedMethod === "pickup" || (!savedMethod && Boolean(result?.config?.store))
      ? "pickup"
      : "delivery",
  );
  useEffect(() => {
    if (savedMethod === "delivery" || savedMethod === "pickup")
      setMethod(savedMethod === "pickup" ? "pickup" : "delivery");
  }, [savedMethod]);
  const busy = dispatching || tasks.some(active);
  async function start(action: Action, params: Data = {}) {
    setError("");
    setDispatching(true);
    try {
      setRequestId(await bridge.start(account.id, action, params));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDispatching(false);
    }
  }
  return (
    <main className="local-page">
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          style={{ marginBottom: 12 }}
        />
      )}
      <Section
        className="section"
        title="送货方式"
        extra={
          account.id !== LOCAL_ID && (
            <Button
              icon={<Import />}
              disabled={busy || account.pending}
              title="把“通用预设”里的地址与送货方式复制到这个账号并保存"
              onClick={() => start("preset_apply")}
            >
              填入通用预设
            </Button>
          )
        }
        info={
          <InfoTip label="送货方式说明">
            每个账号只用一个送货方式：下单时直接按这里的选择走，不再询问。
            “快递配送”用下面的快捷地址；“门店自提”用预设门店并自动选中。
            官网对某个商品只提供另一种方式时，会自动改用可用的那一种。
          </InfoTip>
        }
      >
        <Radio.Group
          className="delivery-method"
          value={method}
          disabled={busy || account.pending}
          onChange={(e) => {
            const value = e.target.value === "pickup" ? "pickup" : "delivery";
            setMethod(value);
            void start("store_save", { method: value });
          }}
        >
          <Radio.Button value="delivery">
            <Truck aria-hidden /> 快递配送
          </Radio.Button>
          <Radio.Button value="pickup">
            <Store aria-hidden /> 门店自提
          </Radio.Button>
        </Radio.Group>
        <Typography.Paragraph type="secondary" className="delivery-hint">
          {method === "pickup"
            ? "下单时直接自提：自动选中下面预设的门店，取货联系人用上面填写的姓名、手机与邮箱。"
            : "下单时直接送货：使用下面的快捷地址，全程全自动，不再询问配送方式与地址来源。"}
        </Typography.Paragraph>
        <div className="form-actions form-actions-column delivery-options">
          <Checkbox
            disabled={busy || account.pending}
            checked={applecare}
            onChange={(e) => {
              const value = e.target.checked;
              setApplecare(value);
              void start("store_save", { applecare: value });
            }}
          >
            同时加入 AppleCare+ 服务计划（含 iPhone 年年焕新）
          </Checkbox>
          <Typography.Paragraph
            type="secondary"
            className="delivery-hint"
            style={{ margin: 0 }}
          >
            AppleCare+
            按官网在购物袋里给出的内联推荐一并加入（价格以官网为准）；
            <InfoTip label="AppleCare+ 说明">
              勾选后，结账时按官网在购物袋里给出的 AppleCare+
              内联推荐一并加入（价格以官网为准）；不勾选则保持裸机下单。商品已挂
              AppleCare+ 时不会重复加入。
            </InfoTip>
          </Typography.Paragraph>
        </div>
      </Section>
      {method === "delivery" ? (
        <AddressForm
          key={`address-${account.id}`}
          account={account}
          busy={busy}
          result={result || undefined}
          prefill={regionTask?.result ?? undefined}
          prefillId={regionTask?.id}
          regionNote={regionNote}
          states={states}
          regionOptions={regionOptions}
          loadRegionOptions={loadRegionOptions}
          start={start}
          startGeneral={startGeneral}
        />
      ) : account.pending ? (
        <Section className="section" title="自提门店">
          <Typography.Paragraph type="secondary">
            完成账号添加后才能查询与保存自提门店。
          </Typography.Paragraph>
        </Section>
      ) : (
        <StoreSection
          busy={busy}
          states={states}
          regionOptions={regionOptions}
          loadRegionOptions={loadRegionOptions}
          storesTask={storesTask}
          storesResult={storesResult ?? undefined}
          delivery={result?.config?.delivery}
          preset={result?.config?.store}
          sku={pickupSku}
          start={start}
        />
      )}
    </main>
  );
}
export function PurchasePreset({
  account,
  bridge,
  refresh,
  follow,
}: {
  account: Account;
  bridge: Bridge;
  refresh: () => Promise<void>;
  /** 传入账号列表时，仍在使用旧默认值的账号会一起更新（购买预设是全局的）。 */
  follow?: Account[];
}) {
  const [items, setItems] = useState<PresetItem[]>(() => presetItems(account));
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const changeItems = (next: PresetItem[]) => {
    setItems(next);
    setStatus("");
  };
  // 快照到达或切换账号后，用已保存的预设回填（编辑中不会重置）。
  const savedSignature = JSON.stringify([
    account.id,
    account.preset_items,
    account.preset_sku,
    account.preset_quantity,
  ]);
  useEffect(() => {
    setItems(presetItems(account));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSignature]);
  return (
    <Section
      className="section"
      title="购买预设"
      info={
        <InfoTip label="购买预设说明">
          预制商品仅用于快捷选择，价格与可购买状态以官网实时结果及结账金额为准。
          {follow
            ? "购买预设对所有账号生效：新账号自动继承，仍在用旧值的账号保存后一起更新。"
            : "保存为此账号的预设。"}
        </InfoTip>
      }
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          setStatus("");
          try {
            const previous = itemsText(presetItems(account));
            const stale = (follow || []).filter(
              (a) => a.id !== account.id && itemsText(ownItems(a)) === previous,
            );
            await bridge.savePreset(account.id, items);
            for (const a of stale) await bridge.savePreset(a.id, items);
            await refresh();
            setStatus(
              stale.length
                ? `购买预设已保存（${stale.length} 个账号跟随更新）`
                : "购买预设已保存",
            );
          } catch (e) {
            setError(String(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        <ItemRows items={items} onChange={changeItems} disabled={saving} />
        <Space>
          <Button type="primary" htmlType="submit" disabled={saving}>
            保存购买预设
          </Button>
          <span role="status">{status}</span>
        </Space>
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            style={{ marginTop: 12 }}
          />
        )}
      </form>
    </Section>
  );
}
export function DuoStatus({ snapshot, bridge, refresh }: PageProps) {
  const [requestId, setRequestId] = useState("");
  const tasks = snapshot.tasks
    .filter((t) => t.account_id === LOCAL_ID && t.action === "catalog")
    .sort((a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at);
  const task = tasks.find((t) => t.id === requestId) || tasks[0];
  const result = tasks.find((t) => t.status === "succeeded")?.result;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const busy = starting || tasks.some(active);
  const live: Data[] = result?.items || [];
  const normalize = (sku: string) => sku.toUpperCase().replace(/\/A$/, "");
  const known = new Set(duoProducts.map((p) => p.sku));
  const rows = [
    ...duoProducts.map((p) => ({
      preset: p,
      item: live.find((i) => normalize(i.sku) === p.sku),
    })),
    ...live
      .filter((i) => !known.has(normalize(i.sku)))
      .map((item) => ({ preset: undefined, item })),
  ];
  const columns = [
    {
      title: "SKU",
      dataIndex: "sku",
      render: (_: unknown, row: Data) => (
        <code>{row.preset?.sku || row.item?.sku}</code>
      ),
    },
    {
      title: "型号 / 配置",
      render: (_: unknown, row: Data) =>
        row.item?.name && row.item.name !== "iPhone Duo"
          ? row.item.name
          : row.preset?.name || row.item?.name,
    },
    {
      title: "价格",
      render: (_: unknown, row: Data) => (
        <>
          {priceText(row.item?.price ?? row.preset?.price)}
          <br />
          <Typography.Text type="secondary">
            {row.item?.price != null ? "官网价格" : "预设参考价"}
          </Typography.Text>
        </>
      ),
    },
    {
      title: "发售 / 加购状态",
      render: (_: unknown, row: Data) => {
        const status =
          row.item?.can_add_to_bag === false
            ? "未开放"
            : row.item?.can_add_to_bag === true
              ? "可加购"
              : "未知";
        return (
          <>
            <Tag
              color={
                status === "可加购"
                  ? "green"
                  : status === "未开放"
                    ? "red"
                    : "default"
              }
            >
              {status}
            </Tag>
            <Typography.Text type="secondary">
              {row.item
                ? row.item.coming_soon === false
                  ? "官网未标记为即将发售；许可待确认"
                  : row.item.reason
                : result
                  ? "本次响应未包含此 SKU"
                  : "待刷新官网"}
            </Typography.Text>
          </>
        );
      },
    },
  ];
  return (
    <main className="local-page duo-page">
      <div className="local-heading">
        <Space size={6} align="center">
          <Typography.Text strong>iPhone Duo 发售与加购状态</Typography.Text>
          <InfoTip label="DUO 状态说明">
            公开发售状态 · 无需登录 Apple 账号。内置 8
            款预制商品，点击刷新读取官网选购页；“未知”表示官网未提供明确的加购许可，不代表有货。只读查询，不进行加购，也不查询门店或配送库存。
          </InfoTip>
        </Space>
        <Space>
          <Button
            type="primary"
            icon={busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
            disabled={busy}
            onClick={async () => {
              setStarting(true);
              setError("");
              try {
                setRequestId(
                  await bridge.start(LOCAL_ID, "catalog", { mode: "duo" }),
                );
                await refresh();
              } catch (e) {
                setError(String(e));
              } finally {
                setStarting(false);
              }
            }}
          >
            刷新状态
          </Button>
          <Button
            icon={<ExternalLink />}
            onClick={() => {
              bridge
                .openUrl(OFFICIAL_DUO_URL)
                .catch((e) => setError(String(e)));
            }}
          >
            打开官网
          </Button>
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          style={{ marginBottom: 12 }}
        />
      )}
      <div className="duo-meta">
        <span>
          {result?.queried_at
            ? `上次成功查询：${new Date(result.queried_at).toLocaleString("zh-CN")}`
            : "尚未查询官网 · 当前为预制资料"}
        </span>
      </div>
      {task?.status === "failed" && result && (
        <p className="error-text">
          刷新失败，下方保留上次成功结果，并非本次实时状态。
        </p>
      )}
      {result?.purchase_message && (
        <Typography.Paragraph type="secondary">
          {result.purchase_message}
        </Typography.Paragraph>
      )}
      <Table
        rowKey={(row) =>
          row.preset?.sku || row.item?.sku || Math.random().toString()
        }
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
      />
    </main>
  );
}
