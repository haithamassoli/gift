import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { LangProvider } from "./i18n";
import Home from "./pages/Home";
import Create from "./pages/Create";
import Sent from "./pages/Sent";
import GiftView from "./pages/GiftView";
import NotFound from "./pages/NotFound";

const client = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={client}>
      <BrowserRouter>
        <LangProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create/:giftType" element={<Create />} />
            <Route path="/sent/:statusKey" element={<Sent />} />
            <Route path="/g/:slug" element={<GiftView />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </LangProvider>
      </BrowserRouter>
    </ConvexProvider>
  </StrictMode>,
);
