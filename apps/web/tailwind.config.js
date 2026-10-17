/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        pixel: ['Silkscreen', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand: {
          50: '#EEF8F1',
          100: '#E3F4E8',
          200: '#BFE6CB',
          400: '#3DBE6A',
          500: '#16A34A',
          600: '#0E9F45',
          700: '#0B7F37',
        },
        ink: { DEFAULT: '#1F1F1F', soft: '#3A3A3A', muted: '#8C8C8C', faint: '#B5B5B5' },
        line: '#EDEDED',
        surface: { DEFAULT: '#F7F7F7', search: '#F3F4F3' },
      },
      fontSize: { '2xs': ['11px', '14px'] },
      boxShadow: { pop: '0 8px 24px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)' },
    },
  },
  plugins: [],
};
