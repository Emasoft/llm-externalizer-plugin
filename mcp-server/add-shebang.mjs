import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Add shebang to compiled JS files that need to be executable
for (const file of ['index.js', 'cli.js']) {
  const filePath = path.join(__dirname, 'dist', file);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('#!')) {
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n' + content);
    console.log(`Added shebang to dist/${file}`);
  } else {
    console.log(`Shebang already present in dist/${file}`);
  }
  fs.chmodSync(filePath, 0o755);
}
