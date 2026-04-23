import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f6ff",
          100: "#dbe8ff",
          500: "#3b6df2",
          600: "#2a55c6",
          700: "#1f4299",
        },
      },
    },
  },
  plugins: [],
};

export default config;
