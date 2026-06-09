import { AppProviders } from "./providers";
import { AppRouter } from "./router";
import "./app.scss";

export function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
