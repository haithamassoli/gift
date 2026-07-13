export default function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="animate-pulse text-stone-500">{label}</p>
    </main>
  );
}
