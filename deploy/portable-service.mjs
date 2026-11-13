#!/usr/bin/env node
// Generate user-level autostart definitions. Never registers or starts them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPrefix, readCurrent, releasePath, verifyRelease } from "./portable-install.mjs";

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const quoteSystemd = value => '"' + String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\")
  .replaceAll('"', '\\"') + '"';

export function renderServiceFiles(os, prefix, node = process.execPath) {
  const launcher = join(prefix, "bin", "synrex.mjs");
  if (os === "linux") return {
    "synrex-portable.service": `[Unit]
Description=Synrex portable user MCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(prefix)}
ExecStart=${quoteSystemd(node)} ${quoteSystemd(launcher)} serve
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`,
  };
  if (os === "darwin") return {
    "org.synrex.portable.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.synrex.portable</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(launcher)}</string><string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(prefix)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`,
  };
  if (os === "win32") {
    const start = join(prefix, "service", "start-synrex.cmd");
    // A script is generated for explicit user action; do not use -Force or
    // mutate the existing DevSpace.WinLaptop task.
    return {
      "start-synrex.cmd": `@echo off\r\n"${node}" "${launcher}" serve\r\n`,
      "register-synrex-task.ps1": `$ErrorActionPreference = 'Stop'
$name = 'Synrex.Portable'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  throw 'Synrex.Portable already exists; inspect it rather than overwrite.'
}
$action = New-ScheduledTaskAction -Execute ${"'" + node.replaceAll("'", "''") + "'"} -Argument ${"'" + ('"' + launcher + '" serve').replaceAll("'", "''") + "'"}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -ErrorAction Stop
Write-Output 'Created Synrex.Portable (not started). Start-ScheduledTask Synrex.Portable after checking the configured role.'
`,
      "start-path.txt": start + "\r\n",
    };
  }
  throw new Error("Portable service generation is supported on Linux, macOS and Windows only.");
}

export function writeServiceFiles(prefix, os = platform()) {
  const current = readCurrent(prefix);
  if (!current) throw new Error("Activate a verified release before generating service files.");
  verifyRelease(releasePath(prefix, current.version), current.version);
  const files = renderServiceFiles(os, prefix);
  const target = join(prefix, "service");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(files)) {
    const path = join(target, name);
    if (existsSync(path) && readFileSync(path, "utf8") !== value)
      throw new Error("Service definition changed; refusing to replace " + path);
  }
  for (const [name, value] of Object.entries(files)) {
    const path = join(target, name);
    if (!existsSync(path)) writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  }
  return Object.keys(files).map(name => join(target, name));
}

function main(args) {
  const action = args.includes("--write") ? "write" : "plan";
  const i = args.indexOf("--prefix");
  const prefix = i >= 0 && args[i + 1] ? resolve(args[i + 1]) : defaultPrefix();
  const platformAt = args.indexOf("--platform");
  const os = platformAt >= 0 && args[platformAt + 1] ? args[platformAt + 1] : platform();
  if (action === "write" && os !== platform()) throw new Error("Cannot register a foreign-platform service.");
  const files = action === "write"
    ? writeServiceFiles(prefix, os) : Object.keys(renderServiceFiles(os, prefix)).map(x => join(prefix, "service", x));
  console.log(JSON.stringify({ action, platform: os, files, registered: false, started: false, existingServiceModified: false }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (error) { console.error("SERVICE_GENERATION_BLOCKED:", error.message); process.exitCode = 1; }
}
