import { useEffect, useState } from "react";
import { ApiFailure } from "./api";
import { useConsole } from "./console";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; error: ApiFailure }
  | {
      status: "ready";
      data: T;
      /** When the data shown arrived. */
      loadedAt: Date;
      /** Why the last automatic reload failed; the data shown is from before it. */
      refreshError: ApiFailure | null;
    };

export interface ApiOptions {
  /** Reload this often while the page is shown, keeping what is shown until the answer arrives. */
  refreshMs?: number;
}

function asFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure(0, "network", `The console API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
}

/** The path of a reload the web app makes by itself: the API logs those apart from reads the operator asked for. */
export function automaticPath(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}refresh=1`;
}

/** Loads one API path; a new path starts loading again. Null loads nothing. */
export function useApi<T>(path: string | null, { refreshMs }: ApiOptions = {}): Loaded<T> {
  const { get } = useConsole();
  const [loaded, setLoaded] = useState<{ path: string | null; value: Loaded<T> }>({ path: null, value: { status: "loading" } });

  useEffect(() => {
    if (path === null) return;
    const target = path;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reloadWhenShown = false;

    function load(automatic: boolean) {
      get<T>(automatic ? automaticPath(target) : target, controller.signal).then(
        (data) => {
          if (controller.signal.aborted) return;
          setLoaded({ path: target, value: { status: "ready", data, loadedAt: new Date(), refreshError: null } });
          schedule();
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (automatic) {
            // A failed reload keeps what is shown, marked as not current.
            setLoaded((current) =>
              current.path === target && current.value.status === "ready"
                ? { path: target, value: { ...current.value, refreshError: asFailure(error) } }
                : current,
            );
            schedule();
          } else {
            setLoaded({ path: target, value: { status: "error", error: asFailure(error) } });
          }
        },
      );
    }
    function schedule() {
      if (refreshMs) timer = setTimeout(reload, refreshMs);
    }
    // A hidden page does not reload; it catches up as soon as it is shown again.
    function reload() {
      if (document.visibilityState === "hidden") reloadWhenShown = true;
      else load(true);
    }
    function onVisibilityChange() {
      if (reloadWhenShown && document.visibilityState === "visible") {
        reloadWhenShown = false;
        load(true);
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    load(false);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [get, path, refreshMs]);

  return loaded.path === path ? loaded.value : { status: "loading" };
}
