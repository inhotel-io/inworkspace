export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** Lets a page render an error panel without building JSX inside try/catch. */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
