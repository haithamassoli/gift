import { GiftPreviewCard } from "../components/GiftPreviewCard";
import { registry } from "../gifts/registry";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-12 text-center">
        <h1 className="font-serif text-6xl tracking-tight text-stone-100 sm:text-7xl">
          Gift
        </h1>
        <p className="mt-4 text-stone-400">
          Beautiful 3D gifts you send as a link. Free, no accounts.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 pb-16 sm:grid-cols-2">
        {Object.values(registry).map((def) => (
          <GiftPreviewCard key={def.id} def={def} />
        ))}
      </div>
    </main>
  );
}
