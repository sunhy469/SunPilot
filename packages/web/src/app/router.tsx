import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { ArtifactsPage } from "../pages/ArtifactsPage";
import { ChatPage } from "../pages/ChatPage";
import { MemoryPage } from "../pages/MemoryPage";
import { RunsPage } from "../pages/RunsPage";
import { SettingsPage } from "../pages/SettingsPage";

export function AppRouter({ token }: { token: string }) {
  const router = createBrowserRouter([
    { path: "/", element: <ChatPage initialToken={token} /> },
    { path: "/chat", element: <ChatPage initialToken={token} /> },
    { path: "/runs", element: <RunsPage /> },
    { path: "/artifacts", element: <ArtifactsPage /> },
    { path: "/memory", element: <MemoryPage /> },
    { path: "/settings", element: <SettingsPage /> },
    { path: "*", element: <ChatPage initialToken={token} /> }
  ]);

  return <RouterProvider router={router} />;
}
