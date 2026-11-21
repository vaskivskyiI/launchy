// Prints a password hash for config.yaml:  npm run hash-password
// The password is read from stdin, so it never appears in shell history or the process list.
import readline from 'node:readline';
import { hashPassword } from './auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
if (process.stdin.isTTY) {
  rl._writeToOutput = (s) => { if (!s.includes('\n') && !s.startsWith('Password')) return; rl.output.write(s); };
}
rl.question('Password: ', (password) => {
  rl.close();
  if (process.stdin.isTTY) process.stderr.write('\n');
  if (password.length < 8) {
    console.error('Use at least 8 characters.');
    process.exit(1);
  }
  console.log(hashPassword(password));
});
