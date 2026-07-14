import { Logo } from "./Logo";

export default function Loading() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6">
      <Logo className="h-12 w-12 animate-pulse" />
      <p className="animate-pulse text-sm text-stone-500">Loading…</p>
    </main>
  );
}
