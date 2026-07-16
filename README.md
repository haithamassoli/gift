# Gift

Beautiful animated 3D gifts you send as a link. Free, no accounts.

## Stack

- Next.js 16 (App Router, Turbopack, React Compiler) — the app tree renders client-only behind a mounted gate in `src/app/providers.tsx`, same behavior as a SPA
- React Three Fiber + drei for the gift scenes in `src/gifts/*/Scene.tsx`
- Convex for gift records, voice-note storage, open-notification emails, and the crawler OG pages
- Tailwind CSS 4

## Develop

```sh
npx convex dev   # backend + generated types (maintains .env.local)
npm run dev      # next dev
```

## Notes

- Link-preview crawlers hitting `/g/:slug` are rewritten to the Convex HTTP action (`next.config.ts`, `beforeFiles`) so shares get per-gift OG tags.
- `/dev` is a dev-only scene harness; it 404s outside development.
