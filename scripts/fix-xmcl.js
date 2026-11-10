const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'node_modules', '@xmcl', 'unzip', 'package.json');

try {
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.main === './index.ts' || pkg.main === 'index.ts') {
      pkg.main = 'dist/index.js';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      console.log('✅ [fix-xmcl] Успешно исправлен @xmcl/unzip (main -> dist/index.js)');
    }
  }
} catch (e) {
  console.error('❌ [fix-xmcl] Ошибка при исправлении:', e.message);
  throw e;
}