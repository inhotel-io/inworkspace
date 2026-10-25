import { createHashRouter, RouterProvider } from "react-router";
import { Shell } from "./Shell";
import { AgentPage } from "./pages/AgentPage";
import { EventsPage } from "./pages/EventsPage";
import { NotFound } from "./pages/NotFound";
import { OverviewPage } from "./pages/OverviewPage";
import { SignedOut } from "./pages/SignedOut";
import { ThreadPage } from "./pages/ThreadPage";

const router = createHashRouter([
  { path: "/signed-out", element: <SignedOut /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "agents/:address", element: <AgentPage /> },
      { path: "agents/:address/threads/:threadId", element: <ThreadPage /> },
      { path: "events", element: <EventsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
