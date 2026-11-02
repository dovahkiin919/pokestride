/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#080b14', 900: '#0d1220', 800: '#141b2e', 700: '#1e2740', 600: '#2a3555' },
        volt: { 400: '#fbbf24', 500: '#f59e0b' },
        electric: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' },
      },
    },
  },
  plugins: [],
};
