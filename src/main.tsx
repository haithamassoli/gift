// Entry module, not a fast-refresh boundary — the lazy route components live here.
/* eslint-disable react-refresh/only-export-components */
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BrowserRouter, Route, Routes } from "react-router";
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

const client = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={client}>
      <BrowserRouter>
        <LangProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/create/:giftType" element={<Create />} />
              <Route path="/sent/:statusKey" element={<Sent />} />
              <Route path="/g/:slug" element={<GiftView />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </LangProvider>
      </BrowserRouter>
    </ConvexProvider>
  </StrictMode>,
);
