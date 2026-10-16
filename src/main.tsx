import { createRoot } from "react-dom/client";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { AccountPrivacyProvider } from "./AccountPrivacy";
import "antd/dist/reset.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <ConfigProvider
    locale={zhCN}
    button={{ autoInsertSpace: false }}
    theme={{ token: { borderRadius: 6 } }}
  >
    <AntdApp>
      <AccountPrivacyProvider>
        <App />
      </AccountPrivacyProvider>
    </AntdApp>
  </ConfigProvider>,
);
