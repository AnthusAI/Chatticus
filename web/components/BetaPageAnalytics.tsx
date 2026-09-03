"use client";

import { useEffect } from "react";
import { initializePageAnalytics } from "@/lib/analytics";

export function BetaPageAnalytics() {
  useEffect(() => {
    initializePageAnalytics();
  }, []);

  return null;
}
