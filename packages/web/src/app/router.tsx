import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { ChatPage } from "../pages/ChatPage";
import { SettingsPage } from "../pages/SettingsPage";

export function AppRouter() {
  const router = createBrowserRouter([
    { path: "/", element: <ChatPage /> },
    { path: "/chat", element: <ChatPage /> },
    { path: "/settings", element: <SettingsPage /> },
    // W9: unknown routes redirect to home instead of silently rendering ChatPage.
    { path: "*", element: <Navigate to="/" replace /> },
  ]);

  return <RouterProvider router={router} />;
}
