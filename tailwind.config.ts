import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#eef2ea",
        panel: "#fbfcf8",
        ink: "#1d2a22",
        accent: "#2f855a",
        accentDeep: "#1f5f41",
        line: "#d6ded2",
        warning: "#b26b00",
        danger: "#c24444"
      },
      fontFamily: {
        sans: ["Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      boxShadow: {
        panel: "0 24px 60px rgba(24, 43, 32, 0.08)"
      }
    }
  },
  plugins: []
} satisfies Config;
