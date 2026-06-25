import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Global Error Boundary — catches render-time errors anywhere in the app
 * and shows a minimal fallback UI so the user can reload instead of
 * staring at a blank screen. Ar11 (code audit).
 *
 * The fallback deliberately uses plain HTML/inline styles so it doesn't
 * depend on antd or SCSS, which may themselves be the source of the error.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
            color: "#111827",
            gap: 16,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 24 }}>Something went wrong</h1>
          <p style={{ margin: 0, color: "#6b7280" }}>
            An unexpected error occurred. Please reload the page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 500,
              color: "#ffffff",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: 16,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
