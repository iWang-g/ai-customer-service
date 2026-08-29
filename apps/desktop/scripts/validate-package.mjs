import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRuntimeConfig } from '../electron/runtime-config.js';
import packageJson from '../package.json' with { type: 'json' };

const desktopDirectory = path.resolve(import.meta.dirname, '..');
const configuredOutput = process.argv[2] || packageJson.build.directories.output;
const expectedConfigPath = process.argv[3] || path.join('config', 'release.json');
const outputDirectory = path.resolve(desktopDirectory, configuredOutput);
const productName = packageJson.build.productName;
const installerPath = path.join(
  outputDirectory,
  `${productName}-${packageJson.version}-Setup.exe`,
);
const resourcesDirectory = path.join(outputDirectory, 'win-unpacked', 'resources');
const runtimeConfigPath = path.join(resourcesDirectory, 'runtime-config.json');
const rpaPath = path.join(resourcesDirectory, 'rpa', 'rpa-agent.exe');

assert.ok(fs.existsSync(installerPath), `Installer is missing: ${installerPath}`);
assert.ok(fs.statSync(installerPath).size > 0, `Installer is empty: ${installerPath}`);
assert.ok(fs.existsSync(rpaPath), `RPA executable is missing: ${rpaPath}`);
assert.ok(fs.statSync(rpaPath).size > 0, `RPA executable is empty: ${rpaPath}`);
assert.ok(fs.existsSync(runtimeConfigPath), `Runtime config is missing: ${runtimeConfigPath}`);

const packagedConfig = validateRuntimeConfig(
  JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8')),
  { rejectLoopback: true },
);
const expectedConfig = validateRuntimeConfig(
  JSON.parse(fs.readFileSync(path.resolve(desktopDirectory, expectedConfigPath), 'utf8')),
  { rejectLoopback: true },
);
assert.deepEqual({ ...packagedConfig }, { ...expectedConfig });

const packagedAgentSource = path.join(resourcesDirectory, 'rpa', 'agent.py');
assert.ok(!fs.existsSync(packagedAgentSource), 'The Python RPA source must not be packaged');

console.log(`Windows package validated: ${installerPath}`);
console.log(`Installer size: ${fs.statSync(installerPath).size} bytes`);
console.log(`RPA size: ${fs.statSync(rpaPath).size} bytes`);
