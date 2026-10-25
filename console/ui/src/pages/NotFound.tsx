import { Link } from "react-router";
import { useDocumentTitle } from "../useDocumentTitle";

export function NotFound() {
  useDocumentTitle("Not found");
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-text-muted">There is no page at this address.</p>
      <Link to="/" className="text-sm font-medium text-brand hover:underline">
        Go to the overview
      </Link>
    </main>
  );
}
