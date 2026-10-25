import "server-only";
import { headers } from "next/headers";
import { forbidden } from "next/navigation";
import { connection } from "next/server";
import { AuthError, authenticate, type Operator } from "./auth";
import { getConfig } from "./config";

/**
 * For pages and components that read data: the gate already ran, but data access checks again.
 * Everything after it renders per request (live data, the current time), never in a prerender.
 */
export async function requireOperator(): Promise<Operator> {
  await connection();
  try {
    return await authenticate(await headers(), getConfig());
  } catch (error) {
    if (error instanceof AuthError) forbidden();
    throw error;
  }
}

export async function currentOperator(): Promise<Operator | null> {
  await connection();
  try {
    return await authenticate(await headers(), getConfig());
  } catch {
    return null;
  }
}
