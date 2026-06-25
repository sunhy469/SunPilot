import { AppProviders } from "./providers";
import { AppRouter } from "./router";
import { ErrorBoundary } from "./ErrorBoundary";
import "./app.scss";

export function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </ErrorBoundary>
  );
}
