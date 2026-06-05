import { ConfigProvider } from "antd";
import { AppRouter } from "./router";
import { getInitialToken } from "../shared/api/client";
import "./app.scss";

export function App({ token = getInitialToken() }: { token?: string }) {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2f6f6b",
          borderRadius: 6,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        }
      }}
    >
      <AppRouter token={token} />
    </ConfigProvider>
  );
}
