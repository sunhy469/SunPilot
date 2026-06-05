import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { ChatPage } from "../pages/ChatPage";
import { LoadingState } from "../shared/components/LoadingState";

const ArtifactsPage = lazy(() => import("../pages/ArtifactsPage").then((module) => ({ default: module.ArtifactsPage })));
const MemoryPage = lazy(() => import("../pages/MemoryPage").then((module) => ({ default: module.MemoryPage })));
const RunsPage = lazy(() => import("../pages/RunsPage").then((module) => ({ default: module.RunsPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

function route(element: ReactNode) {
  return <Suspense fallback={<LoadingState />}>{element}</Suspense>;
}

export function AppRouter({ token }: { token: string }) {
  const router = createBrowserRouter([
    { path: "/", element: <ChatPage initialToken={token} /> },
    { path: "/chat", element: <ChatPage initialToken={token} /> },
    { path: "/runs", element: route(<RunsPage />) },
    { path: "/artifacts", element: route(<ArtifactsPage />) },
    { path: "/memory", element: route(<MemoryPage />) },
    { path: "/settings", element: route(<SettingsPage />) },
    { path: "*", element: <ChatPage initialToken={token} /> }
  ]);

  return <RouterProvider router={router} />;
}
