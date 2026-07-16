"use client";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";

// NODE_ENV is inlined at build time: in production this stub 404s before
// <Harness /> ever renders, so the three.js/R3F harness chunk is never fetched.
const Harness = dynamic(() => import("../harness"), { ssr: false });

export default function DevPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <Harness />;
}
