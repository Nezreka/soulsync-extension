// Ambient declaration for CSS-as-text imports (esbuild `loader: {'.css':
// 'text'}` in scripts/build.mjs). Lets page-badges.ts bundle its stylesheet
// as a string instead of fetching it at runtime.
declare module '*.css' {
  const content: string;
  export default content;
}
