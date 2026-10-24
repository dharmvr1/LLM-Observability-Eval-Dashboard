import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Observability",
  description: "Traces, evals, drift and alerts for LLM applications",
};

// Runs before the first paint so the saved theme is applied without a flash. ?theme=dark or ?theme=light also works.
const THEME_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q||localStorage.getItem("theme");if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;if(q)localStorage.setItem("theme",q)}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
