/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        chassis: {
          base: '#0D0E10',
          panel: '#14161A',
          switch: '#1B1E24',
          recess: '#090A0C',
          ink: '#F3F4F6',
          muted: '#8E95A2',
          signal: '#22C55E',
          amber: '#F59E0B',
          danger: '#EF4444',
        },
      },
    },
  },
  plugins: [],
};
