import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import type { MeResponse } from "@/lib/apiTypes";
import { Forbidden } from "./components/Forbidden";
import { Loading } from "./components/Loading";
import { useConsole } from "./console";
import { useApi } from "./useApi";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "text-text" : "text-text-muted hover:text-text");

/** Every signed-in page: sends the operator to sign in first, then shows the header. */
export function Shell() {
  const { hasSession, signIn, signOut } = useConsole();
  const location = useLocation();
  const signedIn = hasSession();
  const returnTo = location.pathname + location.search;

  useEffect(() => {
    if (!signedIn) void signIn(returnTo);
  }, [signedIn, signIn, returnTo]);

  const me = useApi<MeResponse>(signedIn ? "me" : null);

  if (!signedIn) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-8">
        <Loading label="Opening the mail server's sign-in page…" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight text-text">
            inWorkspace <span className="text-brand">Console</span>
          </Link>
          <nav aria-label="Main" className="flex gap-5 text-sm">
            <NavLink to="/" end className={navClass}>
              Overview
            </NavLink>
            <NavLink to="/events" className={navClass}>
              Events
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-text-muted">
            <a href="/admin/" className="hover:text-text">
              Mail server admin
            </a>
            {me.status === "ready" ? <span title="Signed in at the mail server">{me.data.login}</span> : null}
            <button type="button" onClick={signOut} className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-6 py-8">
        {me.status === "error" && me.error.status === 403 ? <Forbidden message={me.error.message} onSignOut={signOut} /> : <Outlet />}
      </div>
    </div>
  );
}
