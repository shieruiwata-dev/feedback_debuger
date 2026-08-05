/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "system-ui", "-apple-system", "Hiragino Sans", "Hiragino Kaku Gothic ProN",
          "Meiryo", "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
