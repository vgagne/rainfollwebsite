/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './*.html',
    './landing/*.html',
    './survey/*.html',
    './vip-survey/*.html',
    './unsubscribe/*.html',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#727D71',
          secondary: '#DCC9B6',
          tertiary: '#A39171',
          accent1: '#6D4C3D',
          accent2: '#ABC4AB',
        },
        ks: '#05ce78',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
