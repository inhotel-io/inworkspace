import { createHashRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { Shell } from "./Shell";
import { EventsPage } from "./pages/EventsPage";
import { MailboxPage } from "./pages/MailboxPage";
import { NotFound } from "./pages/NotFound";
import { OverviewPage } from "./pages/OverviewPage";
import { SignedOut } from "./pages/SignedOut";
import { ThreadPage } from "./pages/ThreadPage";

/** Links from before 0.4 named mailboxes "agents". */
function FormerAgentLink() {
  const { pathname, search } = useLocation();
  return <Navigate replace to={`/mailboxes${pathname.slice("/agents".length)}${search}`} />;
}

const router = createHashRouter([
  { path: "/signed-out", element: <SignedOut /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "mailboxes/:address", element: <MailboxPage /> },
      { path: "mailboxes/:address/threads/:threadId", element: <ThreadPage /> },
      { path: "agents/*", element: <FormerAgentLink /> },
      { path: "events", element: <EventsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
