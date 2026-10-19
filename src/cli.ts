#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deploySite, verifySite } from './core/deployer';
import type { DeployResult, SiteConfig } from './core/types';

const USAGE = `
wp-deploy-agent

Usage:
  wp-deploy deploy <config.json>    Upload theme + apply settings + verify
  wp-deploy verify <config.json>    Only check that the live site responds

Examples:
  npm run deploy -- config.json
  npm run verify -- config.json

Passwords: set "passwordEnv" in the config and export that variable, e.g.
  PowerShell:  $env:LM_FTP_PASS = "..."   ;  npm run deploy -- config.json
`;

async function main(): Promise<number> {
  const [command, configPath] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE.trim());
    return command ? 0 : 1;
  }
  if (command !== 'deploy' && command !== 'verify') {
    console.error(`Unknown command "${command}".\n${USAGE}`);
    return 1;
  }
  if (!configPath) {
    console.error(`Missing <config.json>.\n${USAGE}`);
    return 1;
  }

  const absoluteConfig = path.resolve(configPath);
  if (!fs.existsSync(absoluteConfig)) {
    console.error(`Config file not found: ${absoluteConfig}`);
    return 1;
  }

  const config = JSON.parse(fs.readFileSync(absoluteConfig, 'utf8')) as SiteConfig;

  // Resolve a relative localDir against the config file's folder.
  if (config.theme?.localDir && !path.isAbsolute(config.theme.localDir)) {
    config.theme.localDir = path.resolve(path.dirname(absoluteConfig), config.theme.localDir);
  }

  const result =
    command === 'deploy'
      ? await deploySite(config, { onLog: (message) => console.log(`  ${message}`) })
      : await verifySite(config);

  printResult(result);
  return result.ok ? 0 : 1;
}

function printResult(result: DeployResult): void {
  console.log('');
  console.log(`Result for ${result.site}: ${result.ok ? 'SUCCESS' : 'FAILED'}`);
  console.log('-'.repeat(64));
  for (const step of result.steps) {
    const mark = step.ok ? 'PASS' : 'FAIL';
    const critical = step.critical ? '' : ' (non-critical)';
    console.log(`[${mark}] ${step.step}${critical}${step.detail ? ` - ${step.detail}` : ''}`);
  }
  console.log('-'.repeat(64));
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
