/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Token system — drives every color in the app. CSS custom properties
        // are defined in src/index.css. Placeholder palette until the
        // Developer Handoff .docx lands and we replace with the official set.
        bg: "var(--bg)",
        surface: "var(--surface)",
        border: "var(--border)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "blue-1": "var(--blue-1)",
        "blue-2": "var(--blue-2)",
        "blue-3": "var(--blue-3)",
        good: "var(--good)",
        warning: "var(--warning)",
        critical: "var(--critical)",
        info: "var(--info)",
        "orange-1": "var(--orange-1)",
        "orange-bg": "var(--orange-bg)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
      },
      maxWidth: {
        page: "1500px",
      },
    },
  },
  plugins: [],
};
