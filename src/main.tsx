// Entry module, not a fast-refresh boundary — the lazy route components live here.
/* eslint-disable react-refresh/only-export-components */
import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { LangProvider } from "./i18n";
import Loading from "./components/Loading";
import Sent from "./pages/Sent";
import NotFound from "./pages/NotFound";

// The 3D-heavy pages pull in three.js/R3F via GiftCanvas — code-split them so the
// status and 404 routes keep the 3D bundle out of the initial entry chunk.
const Home = lazy(() => import("./pages/Home"));
const Create = lazy(() => import("./pages/Create"));
const GiftView = lazy(() => import("./pages/GiftView"));

// Dev-only scene harness. Vite folds import.meta.env.DEV to a literal `false` in
// a build, so the ternary, the routes, the dynamic import and the whole Dev
// chunk are dead code — none of it ships. Keep both guards.
const Dev = import.meta.env.DEV ? lazy(() => import("./pages/Dev")) : null;

const client = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// ponytail: react-router's <ScrollRestoration /> only works under a data router,
// and this app is on <BrowserRouter> — not worth a router rewrite for a reset.
// Restoring scroll on back/forward would need that migration.
function ScrollToTop() {
  const { pathname } = useLocation();
  // Braces are load-bearing: scrollTo returns a Promise in current Chrome (typed
  // void), and an implicit return hands it to useEffect as a cleanup — which throws.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={client}>
      <BrowserRouter>
        <ScrollToTop />
        <LangProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/create/:giftType" element={<Create />} />
              <Route path="/sent/:statusKey" element={<Sent />} />
              <Route path="/g/:slug" element={<GiftView />} />
              {import.meta.env.DEV && Dev && (
                <>
                  <Route path="/dev" element={<Dev />} />
                  <Route path="/dev/:giftType" element={<Dev />} />
                </>
              )}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </LangProvider>
      </BrowserRouter>
    </ConvexProvider>
  </StrictMode>,
);
