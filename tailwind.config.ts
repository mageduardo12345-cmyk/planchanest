import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f3f5f0",
        panel: "#ffffff",
        ink: "#353535",
        accent: "#7ed321",
        accentDeep: "#5da112",
        line: "#dfe4d8",
        shell: "#242a28",
        warning: "#b26b00",
        danger: "#c24444"
      },
      fontFamily: {
        sans: ["Roboto", "Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      boxShadow: {
        panel: "0 18px 44px rgba(31, 38, 34, 0.08)"
      }
    }
  },
  plugins: []
} satisfies Config;
