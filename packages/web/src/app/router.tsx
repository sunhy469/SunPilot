import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { ChatPage } from "../pages/ChatPage";

export function AppRouter() {
  const router = createBrowserRouter([
    { path: "/", element: <ChatPage /> },
    { path: "/chat", element: <ChatPage /> },
    { path: "*", element: <ChatPage /> },
  ]);

  return <RouterProvider router={router} />;
}
