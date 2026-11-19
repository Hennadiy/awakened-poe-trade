// @ts-check
// Builds this fork and installs it over the local Windows install, then (re)starts it.
//
//   npm run install-local            (from main/)
//   npm run update-local             (from main/; or update-app.cmd / the Start menu shortcut)
//   node build/local-install.mjs --hook   (used by .git/hooks/post-commit)
//
// - Installs into %LOCALAPPDATA%\Programs\Awakened PoE Trade (same place as the official
//   installer, so its Start menu shortcut opens this build).
// - Adds a "start with Windows" entry (HKCU\...\Run).
// - Doesn't start the installed app while `npm run dev` is running (they would overlap).
// - Installs the post-commit hook that reruns this after every commit on BRANCH.
// - Adds an "Update Awakened PoE Trade" Start menu shortcut (runs update-app.cmd):
//   pulls BRANCH from origin, reinstalls npm packages if they changed, then builds and installs.
// Log of hook runs: main/dist/local-install.log

import child_process from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const BRANCH = 'dio-ver'
export const PRODUCT_NAME = 'Awakened PoE Trade'
export const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', PRODUCT_NAME)
export const INSTALLED_EXE = path.join(INSTALL_DIR, `${PRODUCT_NAME}.exe`)
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

const MAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = path.resolve(MAIN_DIR, '..')
const RENDERER_DIR = path.join(REPO_DIR, 'renderer')
const UNPACKED_DIR = path.join(MAIN_DIR, 'dist', 'win-unpacked')
const LOCK_FILE = path.join(MAIN_DIR, 'dist', 'local-install.lock')
const UPDATE_CMD = path.join(REPO_DIR, 'update-app.cmd')
const UPDATE_SHORTCUT = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `Update ${PRODUCT_NAME}.lnk`)

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

function installUpdateShortcut () {
  const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`
  powershell([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(UPDATE_SHORTCUT)})`,
    `$s.TargetPath = ${q(UPDATE_CMD)}`,
    `$s.WorkingDirectory = ${q(REPO_DIR)}`,
    `$s.IconLocation = ${q(INSTALLED_EXE + ',0')}`,
    `$s.Description = ${q(`Pull the latest ${BRANCH} and reinstall ${PRODUCT_NAME}`)}`,
    '$s.Save()'
  ].join('; '))
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

function buildAndInstall () {
  run('npm run build', RENDERER_DIR)
  run('npm run build', MAIN_DIR)
  run('npx electron-builder build --win --dir --publish never', MAIN_DIR)

  const devRunning = isDevRunning()
  stopInstalled()
  log(`Copying build to ${INSTALL_DIR}`)
  fs.cpSync(UNPACKED_DIR, INSTALL_DIR, { recursive: true, force: true })
  registerStartup()
  installUpdateShortcut()

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
  if (process.argv.includes('--hook')) {
    log(`post-commit ${child_process.execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf-8' }).trim()}`)
  } else {
    installHook()
  }

  if (acquireLock()) {
    try {
      if (process.argv.includes('--update')) pull()
      do {
        fs.writeFileSync(LOCK_FILE, String(process.pid))
        buildAndInstall()
      } while (fs.readFileSync(LOCK_FILE, 'utf-8').includes('rerun'))
      log('Done')
    } catch (e) {
      log(`FAILED: ${e instanceof Error ? e.message : e}`)
      process.exitCode = 1
    } finally {
      fs.rmSync(LOCK_FILE, { force: true })
    }
  }
}
