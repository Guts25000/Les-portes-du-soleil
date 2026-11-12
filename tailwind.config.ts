import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        glacier: { 50: '#eef7fb', 100: '#d6ecf5', 200: '#a9d6ea', 300: '#7cc0de', 400: '#4fa9d1', 500: '#2b8fbe' },
        anthracite: { 700: '#2a2f36', 800: '#1d2127', 900: '#13161a', 950: '#0b0d10' },
        electric: { 400: '#3d8bff', 500: '#1f6bff', 600: '#1553d6' },
        snow: '#f5f8fb',
      },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'] },
      backdropBlur: { xs: '2px' },
    },
  },
  plugins: [],
};
export default config;
