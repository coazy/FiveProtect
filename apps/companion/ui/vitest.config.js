import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The window is DOM code. Testing it against a real DOM rather than a hand-rolled fake
    // means the tests fail when the markup and the renderer drift apart, which is the only
    // failure mode worth catching here.
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          // The tests load index.html for its structure. Fetching the stylesheet it links
          // to would only add network noise — nothing here asserts on appearance.
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
        },
      },
    },
  },
});
