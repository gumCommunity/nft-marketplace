import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

const web = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: web,
    base: './', // works from any sub-path, e.g. https://<org>.github.io/nft-marketplace/
    build: { target: 'es2020', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 }, // @tonconnect/ui is ~0.6 MB
    server: { fs: { allow: ['..'] } }, // the page imports ../deployments.json
});
