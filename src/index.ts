import { loadConfig, loadSecrets } from './config';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');

const config = loadConfig();
const secrets = loadSecrets();

console.log('Robinhood Trending Bot');
console.log('Config loaded:', JSON.stringify(config, null, 2));
console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
