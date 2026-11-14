// Publishes web/dist as the only content of the gh-pages branch (GitHub Pages: Deploy from a branch).
// Run from the repository root: npm run deploy:web
import { execSync } from 'child_process';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const dist = fileURLToPath(new URL('./dist/', import.meta.url));
if (!existsSync(dist + 'index.html')) throw new Error('web/dist is empty — run npm run build:web first');

const remote = execSync('git remote get-url origin').toString().trim();
const sha = execSync('git rev-parse --short HEAD').toString().trim();
const sh = (cmd) => execSync(cmd, { cwd: dist, stdio: 'inherit' });

writeFileSync(dist + '.nojekyll', ''); // serve files as-is
rmSync(dist + '.git', { recursive: true, force: true });
sh('git init -q -b gh-pages');
sh('git add -A');
sh(`git commit -q -m "Deploy stand from ${sha}"`);
sh(`git push -q -f ${remote} gh-pages`);
rmSync(dist + '.git', { recursive: true, force: true });
console.log(`Published to ${remote} (gh-pages). The page updates in 1-2 minutes.`);
