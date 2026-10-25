export function Forbidden({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-error/30 bg-error-soft p-6 text-sm">
      <p className="font-medium text-error">This account cannot use the console</p>
      <p className="mt-1 text-text-muted">
        {message}. Ask an administrator for that permission, or sign in with another account.
      </p>
      <button type="button" onClick={onSignOut} className="mt-4 rounded-md bg-brand px-3 py-1.5 font-medium text-surface hover:bg-brand-strong">
        Sign out
      </button>
    </div>
  );
}
