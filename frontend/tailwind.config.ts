import type { Config } from "tailwindcss";

/** Every colour resolves through a token in globals.css — no raw values here. */
const ok = (v: string) => `oklch(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: ok("--border"),
        input: ok("--input"),
        ring: ok("--ring"),
        background: ok("--background"),
        foreground: ok("--foreground"),
        primary: { DEFAULT: ok("--primary"), foreground: ok("--primary-foreground") },
        secondary: { DEFAULT: ok("--secondary"), foreground: ok("--secondary-foreground") },
        destructive: { DEFAULT: ok("--destructive"), foreground: ok("--destructive-foreground") },
        muted: { DEFAULT: ok("--muted"), foreground: ok("--muted-foreground") },
        accent: { DEFAULT: ok("--accent"), foreground: ok("--accent-foreground") },
        popover: { DEFAULT: ok("--popover"), foreground: ok("--popover-foreground") },
        card: { DEFAULT: ok("--card"), foreground: ok("--card-foreground") },

        paper: { DEFAULT: ok("--color-paper"), 2: ok("--color-paper-2"), 3: ok("--color-paper-3") },
        line: { DEFAULT: ok("--color-line"), 2: ok("--color-line-2") },
        ink: {
          DEFAULT: ok("--color-ink"),
          2: ok("--color-ink-2"),
          soft: ok("--color-ink-soft"),
          faint: ok("--color-ink-faint"),
        },
        // Calls read lime, puts read periwinkle — the reference's inflow/outflow pair.
        lime: { DEFAULT: ok("--color-lime"), deep: ok("--color-lime-deep"), wash: ok("--color-lime-wash") },
        peri: { DEFAULT: ok("--color-peri"), deep: ok("--color-peri-deep"), wash: ok("--color-peri-wash") },
        flag: { DEFAULT: ok("--color-flag"), deep: ok("--color-flag-deep") },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "var(--radius-sm)",
        sm: "calc(var(--radius-sm) - 3px)",
        pill: "var(--radius-pill)",
      },
      borderWidth: { rule: "var(--rule)", heavy: "var(--rule-heavy)" },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        none: "none",
      },
      fontFamily: {
        sans: ["var(--font-outfit)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-outfit)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        in: "var(--ease-in)",
        "in-out": "var(--ease-in-out)",
      },
      keyframes: {
        "slide-in-right": { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
        "slide-out-right": { from: { transform: "translateX(0)" }, to: { transform: "translateX(100%)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
      },
      animation: {
        "slide-in-right": "slide-in-right 260ms var(--ease-out)",
        "slide-out-right": "slide-out-right 180ms var(--ease-in)",
        "fade-in": "fade-in 180ms var(--ease-out)",
        "fade-out": "fade-out 140ms var(--ease-in)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
