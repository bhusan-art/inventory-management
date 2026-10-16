/** @type {import('tailwindcss').Config} */

/**
 * The tokens from index.css, exposed to Tailwind.
 *
 * Named by ROLE (ink, paper, line, accent) rather than by hue, so a palette
 * change is one file and not a search for every `slate-700` that happened to
 * mean "secondary text".
 *
 * Two radii, not one. A control and a panel are different objects, and giving
 * everything the same corner is what makes an interface read as a kit of
 * identical cards rather than a considered layout.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: 'var(--ink)',
          soft: 'var(--ink-soft)',
          muted: 'var(--ink-muted)',
        },
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        control: '6px',
        panel: '10px',
      },
      boxShadow: {
        // One shadow, for things that genuinely float above the page. Panels
        // get a hairline instead; a soft grey drop under every card is the
        // clearest tell of a template.
        pop: '0 12px 32px -12px rgb(21 32 43 / 0.28)',
      },
    },
  },
  plugins: [],
};
