import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { CursorDance } from "@/components/cursor-dance";

/**
 * Single family, weight-split — the reference's own discipline. Mono is
 * confined to hashes, addresses and raw integers, where proportional
 * figures actively hurt; every human-readable number stays in Outfit with
 * tabular figures.
 */
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-outfit",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mamori",
  description: "Perpetual options on reused Uniswap v4 liquidity, collateralised through 1inch Aqua",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 sm:px-6">
            <Nav />
            {children}
          </div>
          {/* Outside the page column: it is positioned against the viewport, not the layout. */}
          <CursorDance />
        </Providers>
      </body>
    </html>
  );
}
