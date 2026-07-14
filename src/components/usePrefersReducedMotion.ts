import { useSyncExternalStore } from "react";

// One matchMedia + one "change" listener for the whole app; each hook instance
// just joins the subscriber set (React fans the change out), instead of every
// instance registering its own DOM listener. Matters on the gallery, which
// mounts a dozen canvases at once.
const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribers = new Set<() => void>();
mq.addEventListener("change", () => subscribers.forEach((fn) => fn()));

function subscribe(onChange: () => void) {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => mq.matches);
}
