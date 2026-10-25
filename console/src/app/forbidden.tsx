export default function Forbidden() {
  return (
    <main className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-xl font-semibold">Not allowed</h1>
      <p className="mt-2 text-sm text-text-muted">You are signed in, but your account is not on this console&apos;s allow-list.</p>
    </main>
  );
}
