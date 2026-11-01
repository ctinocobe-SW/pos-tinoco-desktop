// No imprimir valores de credenciales. La llave anon de Supabase sí es pública.
const fs = require('node:fs');
const path = require('node:path');
const files = ['.env', '../pos-tinoco/.env.production.local'];
for (const file of files) {
  const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const key = line.split('=')[0].trim();
    if (!['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'POS_ADMIN_API_URL'].includes(key)) {
      throw new Error(`Variable no permitida en instalador: ${key}`);
    }
    if (key === 'POS_ADMIN_API_URL' && !line.slice(line.indexOf('=')+1).trim().startsWith('https://')) throw new Error('Backend administrativo debe usar HTTPS');
    if (key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY') {
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (value.startsWith('sb_secret_')) throw new Error('Llave privada en variable pública');
      const payload = value.split('.')[1];
      if (payload) {
        let claims;
        try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch {}
        if (claims?.role === 'service_role') throw new Error('JWT service_role en variable pública');
      }
    }
  }
}
console.log('Entorno del instalador: solo variables públicas.');
