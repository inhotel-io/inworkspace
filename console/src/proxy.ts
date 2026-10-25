import { NextResponse, type NextRequest } from "next/server";
import { AuthError, authenticate } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { gateFor } from "@/lib/gate";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  const decision = gateFor(request.nextUrl.pathname, settings);
  if (decision === "pass") return NextResponse.next();
  if (decision === "not-found") return new NextResponse(null, { status: 404 });
  try {
    await authenticate(request.headers, settings);
    return NextResponse.next();
  } catch (error) {
    if (error instanceof AuthError) {
      return new NextResponse("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    throw error;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
