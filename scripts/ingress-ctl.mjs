/** Owner-local control client for the optional stable ingress gate. */
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function sendIngressCommand(socketPath, command, timeoutMs = 1800) {
  if (!socketPath?.startsWith('/')) throw new Error('expected absolute owner-local Unix socket');
  if (!['STATUS', 'PAUSE', 'RESUME'].includes(command)) throw new Error('invalid ingress operation');
  return new Promise((resolveResult, reject) => {
    const connection = connect(socketPath);
    let output = '';
    let finished = false;
    const settle = (error, result) => {
      if (finished) return;
      finished = true;
      connection.destroy();
      if (error) reject(error);
      else resolveResult(result);
    };
    connection.setTimeout(timeoutMs, () => settle(new Error('ingress control timed out')));
    connection.once('connect', () => connection.write(command + '\n'));
    connection.setEncoding('utf8');
    connection.on('data', (data) => {
      output += data;
      if (output.length > 4096) settle(new Error('ingress control response too large'));
    });
    connection.once('end', () => {
      try {
        const result = JSON.parse(output);
        if (result.error || typeof result.active !== 'number' || typeof result.pending !== 'number') {
          throw new Error('invalid ingress control response');
        }
        settle(null, result);
      } catch (error) { settle(error); }
    });
    connection.once('error', (error) => settle(error));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const socket = args[args.indexOf('--socket') + 1];
  const operation = args[args.indexOf('--command') + 1];
  sendIngressCommand(socket, operation).then((result) => {
    console.log(JSON.stringify(result));
    if (args.includes('--idle') && result.active > 0) process.exitCode = 75;
  }).catch((error) => {
    console.error(`INGRESS_CONTROL_FAILED: ${error.message}`);
    process.exitCode = 2;
  });
}
