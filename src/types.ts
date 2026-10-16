export interface PresetItem {
  sku: string;
  quantity: number;
}
export interface Account {
  id: string;
  name: string;
  email: string;
  pending?: boolean;
  preset_sku?: string;
  preset_quantity?: number;
  /** 预设的全部商品（多商品下单）；preset_sku / preset_quantity 是第一件的镜像。 */
  preset_items?: PresetItem[];
}
export type Action =
  | "enroll"
  | "login"
  | "me"
  | "bag"
  | "add"
  | "purchase"
  | "timed_purchase"
  | "checkout"
  | "orders"
  | "catalog"
  | "address_read"
  | "address_save"
  | "region"
  | "region_options"
  | "stores"
  | "store_save"
  | "preset_apply"
  | "import_auth"
  | "forget_password"
  | "qr";
export type Data = Record<string, any>;
export interface Prompt {
  id: string;
  kind: "password" | "code" | "text" | "select" | "confirm";
  label: string;
  default?: any;
  options?: { value: any; label: string }[];
  actions?: { value: string; label: string }[];
  details?: Data;
  account?: string;
}
export interface Task {
  id: string;
  account_id: string;
  action: Action;
  status: string;
  stage: string;
  created_at: number;
  updated_at: number;
  prompt: Prompt | null;
  result: Data | null;
  order_submitted: boolean;
  logs: string[];
}
export interface Snapshot {
  accounts: Account[];
  tasks: Task[];
  data_dir: string;
  defaults?: Account;
}
export const LOCAL_ID = "00000000-0000-0000-0000-000000000000";
export const localDefaults: Account = {
  id: LOCAL_ID,
  name: "通用预设",
  email: "",
  preset_sku: "MK2U4CH",
  preset_quantity: 2,
  preset_items: [{ sku: "MK2U4CH", quantity: 2 }],
};
export const active = (task: Task) =>
  ["queued", "running", "waiting"].includes(task.status);
export const actionNames: Record<Action, string> = {
  enroll: "添加并登录账号",
  login: "登录账号",
  me: "检查登录",
  bag: "查询购物袋",
  add: "设置购买数量",
  purchase: "购买商品",
  timed_purchase: "定时抢购",
  checkout: "结算购物袋",
  orders: "查询订单",
  catalog: "查询商品",
  address_read: "读取地址预设",
  address_save: "保存地址预设",
  region: "读取当前地区",
  region_options: "读取省市区",
  stores: "查询零售店",
  store_save: "保存送货方式与门店",
  preset_apply: "填入通用预设",
  import_auth: "导入会话",
  forget_password: "忘记密码",
  qr: "获取付款二维码",
};
export const stateNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "需要操作",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
