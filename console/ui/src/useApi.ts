import { useEffect, useState } from "react";
import { ApiFailure } from "./api";
import { useConsole } from "./console";

export type Loaded<T> = { status: "loading" } | { status: "error"; error: ApiFailure } | { status: "ready"; data: T };

function asFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure(0, "network", `The console API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
}

/** Loads one API path; a new path starts loading again. Null loads nothing. */
export function useApi<T>(path: string | null): Loaded<T> {
  const { get } = useConsole();
  const [loaded, setLoaded] = useState<{ path: string | null; value: Loaded<T> }>({ path: null, value: { status: "loading" } });

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    get<T>(path, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoaded({ path, value: { status: "ready", data } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ path, value: { status: "error", error: asFailure(error) } });
      },
    );
    return () => controller.abort();
  }, [get, path]);

  return loaded.path === path ? loaded.value : { status: "loading" };
}
