import { lazy, Suspense } from "react";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { ChatPage } from "../pages/ChatPage";

// Route-level lazy chunk: SettingsPage pulls in code editor + form libs that
// are not needed for the default chat route.
const SettingsPage = lazy(() =>
  import("../pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

export function AppRouter() {
  const router = createBrowserRouter([
    { path: "/", element: <ChatPage /> },
    { path: "/chat", element: <ChatPage /> },
    {
      path: "/settings",
      element: (
        <Suspense fallback={null}>
          <SettingsPage />
        </Suspense>
      ),
    },
    // W9: unknown routes redirect to home instead of silently rendering ChatPage.
    { path: "*", element: <Navigate to="/" replace /> },
  ]);

  return <RouterProvider router={router} />;
}
