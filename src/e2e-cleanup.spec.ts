import { spawn } from 'node:child_process';
import { join } from 'node:path';

it('E2E runner closes its fixture when application imports fail', async () => {
	const runner = join(__dirname, '../scripts/e2e.cjs');
	const program = `
		global.fetch = async () => new Response(JSON.stringify({access_token:'test-access'}), {status:201,headers:{'set-cookie':'session=value; HttpOnly'}});
		const Module = require('node:module');
		const original = Module._load;
		Module._load = function(name, ...args) { if(name === '../dist/app.module') throw new Error('simulated import failure'); return original.call(this,name,...args); };
		require(${JSON.stringify(runner)});
	`;
	const environment: NodeJS.ProcessEnv = { ...process.env, BFF_E2E_OAUTH_URL: 'http://unused.invalid', BFF_E2E_COURSES_URL: 'http://unused.invalid', BFF_E2E_USERNAME: 'test@example.invalid', BFF_E2E_PASSWORD: 'test-password' };
	delete environment.BFF_E2E_RECEIPT;
	const result = await new Promise<{ timedOut: boolean; code: number | null; output: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ['-e', program], { env: environment });
		let timedOut = false, output = '';
		const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
		child.stdout.on('data', chunk => output += chunk);
		child.stderr.on('data', chunk => output += chunk);
		child.on('error', reject);
		child.on('close', code => { clearTimeout(timeout); resolve({ timedOut, code, output }); });
	});
	expect(result.timedOut).toBe(false);
	expect(result.code).toBe(1);
	expect(result.output).toContain('simulated import failure');
});
