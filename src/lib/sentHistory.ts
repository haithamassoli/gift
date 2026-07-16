// Device-local "gifts you've sent" history, shared by the create page (write)
// and the homepage (read). localStorage only — statusKeys are secrets, so no
// server list exists. ponytail: no cross-device sync; add accounts if asked.
export type SentEntry = {
  statusKey: string;
  recipientName: string;
  giftType: string;
  createdAt: number;
};

const KEY = "gift.sent.v1";
const CAP = 50;

export function loadSent(): SentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SentEntry[];
    return Array.isArray(list)
      ? list.filter((e) => typeof e?.statusKey === "string")
      : [];
  } catch {
    return [];
  }
}

export function addSent(entry: SentEntry): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify([entry, ...loadSent()].slice(0, CAP)),
    );
  } catch {
    // Private browsing / quota exceeded — history is best-effort.
  }
}

export function clearSent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — absence of history is the goal anyway.
  }
}
