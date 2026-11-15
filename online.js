// Arranca el servidor y un túnel público de Cloudflare (sin cuenta).
// Uso: npm run online
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const local = path.join(__dirname, 'bin', 'cloudflared.exe');
const exe = fs.existsSync(local) ? local : 'cloudflared';

if (spawnSync(exe, ['--version']).error) {
  console.error('\n❌ No se encontró "cloudflared". Instálalo con:\n');
  console.error('   winget install --id Cloudflare.cloudflared\n');
  console.error('Luego cierra y vuelve a abrir la terminal y ejecuta: npm run online\n');
  process.exit(1);
}

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit', env: { ...process.env, PORT },
});

const tunnel = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
let shown = false;
const onData = d => {
  const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !shown) {
    shown = true;
    console.log('\n🌍 ¡Listo! Comparte este enlace con tus amigos (funciona desde cualquier red):\n');
    console.log(`   ${m[0]}\n`);
    console.log('   (Deja esta ventana abierta mientras juegan. Ctrl+C para cerrar.)\n');
  }
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);

const stop = () => { tunnel.kill(); server.kill(); process.exit(); };
process.on('SIGINT', stop);
tunnel.on('exit', code => { if (!shown) console.error('El túnel se cerró (código ' + code + ').'); stop(); });
server.on('exit', stop);
