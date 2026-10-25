import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-text-muted">There is no agent, thread or page at this address.</p>
      <Link href="/" className="mt-6 inline-block text-sm font-medium text-brand hover:underline">
        Back to the overview
      </Link>
    </main>
  );
}
