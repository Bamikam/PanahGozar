import type { Config } from "tailwindcss";

const withOpacity = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/web/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: withOpacity("--surface"),
          raised: withOpacity("--surface-raised"),
          overlay: withOpacity("--surface-overlay"),
          line: withOpacity("--line"),
        },
        ink: {
          DEFAULT: withOpacity("--ink"),
          muted: withOpacity("--muted"),
          faint: withOpacity("--faint"),
        },
        accent: {
          DEFAULT: withOpacity("--accent"),
          strong: withOpacity("--accent-strong"),
          soft: withOpacity("--accent-soft"),
        },
        ok: withOpacity("--ok"),
        warn: withOpacity("--warn"),
        danger: withOpacity("--danger"),
        muted: withOpacity("--muted"),
      },
      fontFamily: {
        sans: [
          "Vazirmatn",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "JetBrains Mono", "Menlo", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 18px 48px -24px rgb(2 6 23 / 0.55)",
        glow: "0 0 0 1px rgb(var(--accent) / 0.25), 0 18px 40px -22px rgb(var(--accent) / 0.55)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
      animation: {
        "fade-up": "fade-up 180ms ease-out",
        shimmer: "shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
