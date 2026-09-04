/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f5f1e8',
        'paper-deep': '#eae4d6',
        'paper-edge': '#dcd3c0',
        ink: '#2b2a26',
        'ink-soft': '#57534e',
        'ink-faint': '#8a8578',
        cinnabar: '#c03f2b',
        'cinnabar-deep': '#a8331f',
      },
      fontFamily: {
        song: ['"Noto Serif SC"', 'serif'],
        sans: ['"Noto Sans SC"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', '"Cascadia Mono"', 'monospace'],
      },
      boxShadow: {
        paper: '0 1px 2px rgba(43,42,38,.06), 0 8px 24px rgba(43,42,38,.06)',
        seal: 'inset 0 0 0 1.5px rgba(192,63,43,.85)',
      },
    },
  },
  plugins: [],
}