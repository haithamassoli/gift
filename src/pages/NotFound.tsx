import { Link } from "react-router";

export default function NotFound({
  heading = "This link doesn't lead to a gift",
  copy = "It may have been mistyped, or the gift never existed.",
}: {
  heading?: string;
  copy?: string;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <span className="text-7xl" aria-hidden="true">
        🎁
      </span>
      <h1 className="font-serif text-3xl text-stone-100">{heading}</h1>
      <p className="text-stone-400">{copy}</p>
      <Link
        to="/"
        className="inline-flex min-h-[48px] items-center rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        Browse gifts
      </Link>
    </main>
  );
}
