import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NavBar } from "@/components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "PharmaSentinel",
  description:
    "Governed text-to-SQL over OpenFDA FAERS and ClinicalTrials.gov data.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="app-shell">
          <header className="app-header">
            <h1>PharmaSentinel</h1>
            <p className="app-subtitle">
              Governed text-to-SQL over OpenFDA FAERS and ClinicalTrials.gov
            </p>
          </header>
          <NavBar />
          <section className="tab-panel" role="tabpanel">
            {children}
          </section>
        </main>
      </body>
    </html>
  );
}
