/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // No CSS framework wired yet — this is a placeholder so the standard
    // Next.js build pipeline (which looks for postcss.config.mjs) has
    // something to load. Add tailwindcss/autoprefixer etc. here if/when
    // the real tab UIs need them.
  },
};

export default config;
