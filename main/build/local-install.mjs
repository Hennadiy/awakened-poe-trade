// @ts-check
// Builds this fork and installs it for the current Windows user, then (re)starts it.
//
//   npm run install-local            (from main/)
//   npm run update-local             (from main/; or update-app.cmd / the Start menu shortcut)
//   node build/local-install.mjs --hook   (used by .git/hooks/post-commit)
//
// - Installs into %LOCALAPPDATA%\Programs\<PRODUCT_NAME> with a Start menu shortcut.
//   Settings stay in %APPDATA%\awakened-poe-trade, shared with the official app.
// - Uninstalls the official "Awakened PoE Trade" (it would start with Windows too).
// - Adds a "start with Windows" entry (HKCU\...\Run).
// - Registers an on-demand scheduled task "Auto-update <PRODUCT_NAME>" that runs this
//   with --task, hidden, in the user's Windows session (log: main/dist/local-install.log).
// - When started from Claude Code (CLAUDECODE=1, also inherited by the git hook after its
//   commits) it doesn't install itself: the Claude desktop app runs commands isolated, and
//   their writes to %LOCALAPPDATA% and HKCU are invisible to Windows. It starts that task
//   instead (once a normal install or update has registered it).
//   --force installs anyway, e.g. for the Claude Code CLI in a normal terminal.
// - Doesn't start the installed app while `npm run dev` is running (they would overlap).
// - Installs the post-commit hook that reruns this after every commit on BRANCH.
// - Adds an "Update <PRODUCT_NAME>" Start menu shortcut, hidden (auto-update.cmd --update;
//   update-app.cmd is the same with a console): pulls BRANCH from origin, reinstalls npm
//   packages if they changed, then builds and installs. Hidden runs show a message on failure.
// Log of hook runs: main/dist/local-install.log

import child_process from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const BRANCH = 'dio-ver'
export const PRODUCT_NAME = 'Awakened POE Trade f. Dio' // productName in electron-builder.yml
export const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', PRODUCT_NAME)
export const INSTALLED_EXE = path.join(INSTALL_DIR, `${PRODUCT_NAME}.exe`)
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const START_MENU = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const APP_SHORTCUT = path.join(START_MENU, `${PRODUCT_NAME}.lnk`)
// the official app, and the name this fork used to install under
const OFFICIAL_NAME = 'Awakened PoE Trade'
const OFFICIAL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', OFFICIAL_NAME)

const MAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = path.resolve(MAIN_DIR, '..')
const RENDERER_DIR = path.join(REPO_DIR, 'renderer')
const UNPACKED_DIR = path.join(MAIN_DIR, 'dist', 'win-unpacked')
const LOCK_FILE = path.join(MAIN_DIR, 'dist', 'local-install.lock')
// conhost --headless re-splits its arguments and breaks nested quotes: this path must not need any
const AUTO_UPDATE_CMD = path.join(MAIN_DIR, 'build', 'auto-update.cmd')
const UPDATE_SHORTCUT = path.join(START_MENU, `Update ${PRODUCT_NAME}.lnk`)
const AUTO_TASK = `Auto-update ${PRODUCT_NAME}`

const log = (/** @type {string} */ msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)

function run (/** @type {string} */ cmd, /** @type {string} */ cwd) {
  log(`> ${cmd}  (${path.relative(REPO_DIR, cwd) || '.'})`)
  child_process.execSync(cmd, { cwd, stdio: 'inherit' })
}

function powershell (/** @type {string} */ command) {
  return child_process.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf-8' }).trim()
}

/** Is the dev build (main/node_modules/electron) running? */
export function isDevRunning () {
  const devExe = path.join(MAIN_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  const out = powershell(`@(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${devExe.replace(/'/g, "''")}' }).Count`)
  return Number(out) > 0
}

export function isInstalledRunning () {
  const out = powershell(`@(Get-Process '${PRODUCT_NAME}' -ErrorAction SilentlyContinue).Count`)
  return Number(out) > 0
}

export function stopInstalled () {
  if (!isInstalledRunning()) return false
  log(`Stopping installed ${PRODUCT_NAME}`)
  try {
    child_process.execFileSync('taskkill', ['/F', '/T', '/IM', `${PRODUCT_NAME}.exe`], { stdio: 'ignore' })
  } catch {}
  // wait for file handles to be released
  for (let i = 0; i < 20 && isInstalledRunning(); i++) {
    child_process.execSync('ping -n 2 127.0.0.1 > nul')
  }
  return true
}

export function startInstalled () {
  if (!fs.existsSync(INSTALLED_EXE)) return
  log(`Starting installed ${PRODUCT_NAME}`)
  const child = child_process.spawn(INSTALLED_EXE, [], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR })
  child.unref()
}

function registerStartup () {
  child_process.execFileSync('reg', ['add', RUN_KEY, '/v', PRODUCT_NAME, '/t', 'REG_SZ', '/d', `"${INSTALLED_EXE}"`, '/f'], { stdio: 'ignore' })
  // Task Manager > Startup apps state: 02 = enabled, 03 = disabled. Keep the user's choice.
  let approved = true
  try {
    child_process.execFileSync('reg', ['query', STARTUP_APPROVED_KEY, '/v', PRODUCT_NAME], { stdio: 'ignore' })
  } catch {
    approved = false
  }
  if (!approved) {
    child_process.execFileSync('reg', ['add', STARTUP_APPROVED_KEY, '/v', PRODUCT_NAME, '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f'], { stdio: 'ignore' })
  }
  log('Registered to start with Windows')
}

function installHook () {
  const hookFile = path.join(REPO_DIR, '.git', 'hooks', 'post-commit')
  const hook = [
    '#!/bin/sh',
    '# Installed by main/build/local-install.mjs: rebuild and reinstall the app after commits',
    `[ "$(git rev-parse --abbrev-ref HEAD)" = "${BRANCH}" ] || exit 0`,
    'mkdir -p main/dist',
    'nohup node main/build/local-install.mjs --hook >> main/dist/local-install.log 2>&1 &',
    ''
  ].join('\n')
  if (!fs.existsSync(hookFile) || fs.readFileSync(hookFile, 'utf-8') !== hook) {
    fs.writeFileSync(hookFile, hook)
    log('Installed post-commit hook')
  }
}

const psQuote = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`

function createShortcut (/** @type {string} */ file, /** @type {string} */ target, /** @type {string} */ workDir, /** @type {string} */ description, args = '') {
  const q = psQuote
  powershell([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)})`,
    `$s.TargetPath = ${q(target)}`,
    `$s.Arguments = ${q(args)}`,
    `$s.WorkingDirectory = ${q(workDir)}`,
    `$s.IconLocation = ${q(INSTALLED_EXE + ',0')}`,
    `$s.Description = ${q(description)}`,
    '$s.Save()'
  ].join('; '))
}

function installShortcuts () {
  createShortcut(APP_SHORTCUT, INSTALLED_EXE, INSTALL_DIR, PRODUCT_NAME)
  // runs hidden; update-app.cmd is the same with a visible console
  createShortcut(UPDATE_SHORTCUT, 'conhost.exe', REPO_DIR, `Pull the latest ${BRANCH} and reinstall ${PRODUCT_NAME}`,
    `--headless cmd.exe /c "${AUTO_UPDATE_CMD}" --update`)
}

/** For runs without a console (--task): tell the user that it failed. */
function showFailure (/** @type {string} */ message) {
  const text = `${PRODUCT_NAME} update failed:\n\n${message}\n\nLog: ${path.join(MAIN_DIR, 'dist', 'local-install.log')}`
  child_process.spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${psQuote(text)}, ${psQuote(PRODUCT_NAME)}, 'OK', 'Error') | Out-Null`
  ], { stdio: 'ignore', windowsHide: true })
}

/** On-demand task that installs in the user's session, hidden (conhost --headless), logging to main/dist/local-install.log. */
function registerAutoUpdateTask () {
  const q = psQuote
  powershell([
    `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${q(`--headless cmd.exe /c "${AUTO_UPDATE_CMD}"`)} -WorkingDirectory ${q(REPO_DIR)}`,
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)',
    `Register-ScheduledTask -TaskName ${q(AUTO_TASK)} -Action $a -Settings $s -Description ${q(`Rebuilds and reinstalls ${PRODUCT_NAME} after commits made from Claude Code`)} -Force | Out-Null`
  ].join('; '))
}

/** Starts the auto-update task; false if it isn't registered yet. */
function startAutoUpdateTask () {
  try {
    child_process.execFileSync('schtasks', ['/run', '/tn', AUTO_TASK], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Removes the official app (or this fork installed under its name): process, files, autostart, shortcuts. */
function removeOfficialInstall () {
  const uninstaller = path.join(OFFICIAL_DIR, `Uninstall ${OFFICIAL_NAME}.exe`)
  const officialExe = path.join(OFFICIAL_DIR, `${OFFICIAL_NAME}.exe`)
  if (fs.existsSync(officialExe)) {
    log(`Removing ${OFFICIAL_DIR}`)
    try {
      child_process.execFileSync('taskkill', ['/F', '/T', '/IM', `${OFFICIAL_NAME}.exe`], { stdio: 'ignore' })
    } catch {}
    if (fs.existsSync(uninstaller)) {
      // NSIS relaunches itself from %TEMP% and returns at once, wait for it to finish
      try { child_process.execFileSync(uninstaller, ['/currentuser', '/S'], { stdio: 'ignore' }) } catch {}
      for (let i = 0; i < 30 && fs.existsSync(officialExe); i++) {
        child_process.execSync('ping -n 2 127.0.0.1 > nul')
      }
    }
    fs.rmSync(OFFICIAL_DIR, { recursive: true, force: true })
  }
  for (const key of [RUN_KEY, STARTUP_APPROVED_KEY]) {
    try {
      child_process.execFileSync('reg', ['delete', key, '/v', OFFICIAL_NAME, '/f'], { stdio: 'ignore' })
    } catch {}
  }
  for (const name of [`${OFFICIAL_NAME}.lnk`, `Update ${OFFICIAL_NAME}.lnk`]) {
    fs.rmSync(path.join(START_MENU, name), { force: true })
  }
}

function git (/** @type {string} */ args) {
  return child_process.execSync(`git ${args}`, { cwd: REPO_DIR, encoding: 'utf-8' }).trim()
}

/** Pulls BRANCH from origin; reinstalls npm packages of the parts whose lockfile changed. */
function pull () {
  const branch = git('rev-parse --abbrev-ref HEAD')
  if (branch !== BRANCH) {
    throw new Error(`The repo is on branch "${branch}", switch to "${BRANCH}" to update`)
  }
  const before = git('rev-parse HEAD')
  run(`git pull --ff-only origin ${BRANCH}`, REPO_DIR)
  const after = git('rev-parse HEAD')
  if (before === after) {
    log('No new commits, reinstalling the current version')
    return
  }
  const changed = git(`diff --name-only ${before} ${after}`).split('\n')
  for (const dir of [RENDERER_DIR, MAIN_DIR]) {
    if (changed.includes(`${path.basename(dir)}/package-lock.json`)) run('npm ci', dir)
  }
}

const WIN_CODE_SIGN = {
  name: 'winCodeSign-2.6.0',
  url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
  sha512: '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA=='
}

/**
 * electron-builder sets the exe's icon and version with rcedit from winCodeSign-2.6.0.7z.
 * That archive also holds macOS symlinks, and unpacking it fails without admin rights or
 * Developer Mode ("A required privilege is not held by the client"). Unpack it ourselves
 * without the macOS part, where electron-builder looks for it.
 */
export async function ensureWinCodeSign () {
  const cacheDir = path.join(process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache'), 'winCodeSign')
  const target = path.join(cacheDir, WIN_CODE_SIGN.name)
  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) return

  log(`Preparing ${WIN_CODE_SIGN.name} for electron-builder`)
  fs.mkdirSync(cacheDir, { recursive: true })
  const archive = path.join(cacheDir, `${WIN_CODE_SIGN.name}.7z`)
  const sha512 = (/** @type {Buffer} */ data) => crypto.createHash('sha512').update(data).digest('base64')
  if (!fs.existsSync(archive) || sha512(fs.readFileSync(archive)) !== WIN_CODE_SIGN.sha512) {
    const res = await fetch(WIN_CODE_SIGN.url)
    if (!res.ok) throw new Error(`Downloading ${WIN_CODE_SIGN.url}: HTTP ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    if (sha512(data) !== WIN_CODE_SIGN.sha512) throw new Error(`${WIN_CODE_SIGN.name}.7z: checksum mismatch`)
    fs.writeFileSync(archive, data)
  }
  const tmp = `${target}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  const sevenZip = path.join(MAIN_DIR, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  child_process.execFileSync(sevenZip, ['x', '-bd', '-y', `-o${tmp}`, archive, '-xr!darwin'], { stdio: 'ignore' })
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(tmp, target)
}

/** One build+install at a time; a commit during a build triggers one more run afterwards. */
function acquireLock () {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').split('\n')[0])
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (alive) {
      fs.appendFileSync(LOCK_FILE, '\nrerun')
      log(`Another install is running (pid ${pid}), it will run again when done`)
      return false
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
  return true
}

async function buildAndInstall () {
  run('npm run build', RENDERER_DIR)
  run('npm run build', MAIN_DIR)
  await ensureWinCodeSign()
  run('npx electron-builder build --win --dir --publish never', MAIN_DIR)

  const devRunning = isDevRunning()
  stopInstalled()
  removeOfficialInstall()
  log(`Copying build to ${INSTALL_DIR}`)
  fs.cpSync(UNPACKED_DIR, INSTALL_DIR, { recursive: true, force: true })
  registerStartup()
  installShortcuts()
  registerAutoUpdateTask()

  if (devRunning) {
    log('Dev build is running, not starting the installed app (it starts again when dev stops)')
  } else {
    startInstalled()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.error('local-install only supports Windows')
    process.exit(1)
  }
  const head = () => child_process.execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf-8' }).trim()
  if (process.argv.includes('--hook')) {
    log(`post-commit ${head()}`)
  } else if (process.argv.includes('--task')) {
    log(`${AUTO_TASK}: ${head()}`)
  } else {
    installHook()
  }

  // The Claude desktop app runs commands in an isolated environment: what they write to
  // %LOCALAPPDATA% and HKCU is only visible inside it, so an install from there doesn't
  // exist for Windows (no Start menu target, no start with Windows).
  const fromClaude = process.env.CLAUDECODE === '1' && !process.argv.includes('--force')
  if (fromClaude) {
    if (startAutoUpdateTask()) {
      log(`Started from Claude Code: installing via the "${AUTO_TASK}" task, in your Windows session`)
    } else {
      log(`Started from Claude Code, not installing: its installs aren't visible to Windows.
  Run "Update ${PRODUCT_NAME}" from the Start menu once; after that commits install automatically.`)
    }
  }

  if (!fromClaude && acquireLock()) {
    try {
      if (process.argv.includes('--update')) pull()
      do {
        fs.writeFileSync(LOCK_FILE, String(process.pid))
        await buildAndInstall()
      } while (fs.readFileSync(LOCK_FILE, 'utf-8').includes('rerun'))
      log('Done')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`FAILED: ${message}`)
      process.exitCode = 1
      if (process.argv.includes('--task')) showFailure(message.split('\n')[0])
    } finally {
      fs.rmSync(LOCK_FILE, { force: true })
    }
  }
}
