import { useEffect } from "react";
import { AppProviders } from "./providers";
import { AppRouter } from "./router";
import { removeLegacyTokenFromUrl } from "../shared/api/client";
import "./app.scss";

export function App() {
  useEffect(() => {
    removeLegacyTokenFromUrl();
  }, []);

  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
