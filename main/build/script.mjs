// @ts-check
import child_process from 'child_process'
import electron from 'electron'
import esbuild from 'esbuild'

const isDev = !process.argv.includes('--prod')

// The installed app shares the config dir and single-instance lock with the dev build,
// and both would grab the same hotkeys. Stop it while developing, restart it on exit.
if (isDev && process.platform === 'win32') {
  const local = await import('./local-install.mjs')
  local.stopInstalled()
  const restart = () => {
    try {
      if (!local.isInstalledRunning()) local.startInstalled()
    } finally {
      process.exit()
    }
  }
  process.on('SIGINT', restart)
  process.on('SIGHUP', restart)
  process.on('SIGTERM', restart)
}

const electronRunner = (() => {
  /** @type {child_process.ChildProcess | null} */
  let handle = null
  return {
    restart () {
      console.info('Restarting Electron process.')

      if (handle) handle.kill()
      const args = ['.']
      if (process.platform === 'linux') {
        args.unshift('--ozone-platform', 'x11')
      }
      handle = child_process.spawn(String(electron), args, {
        stdio: 'inherit'
      })
    }
  }
})()

const visionBuild = await esbuild.build({
  entryPoints: ['src/vision/link-worker.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'dist/vision.js'
})

const mainContext = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: !isDev,
  platform: 'node',
  external: ['electron', 'uiohook-napi', 'electron-overlay-window'],
  outfile: 'dist/main.js',
  define: {
    'process.env.STATIC': (isDev) ? '"../build/icons"' : '"."',
    'process.env.VITE_DEV_SERVER_URL': (isDev) ? '"http://localhost:5173"' : 'null'
  },
  plugins: (isDev) ? [{
    name: 'electron-runner',
    setup (build) {
      build.onEnd((result) => {
        if (!result.errors.length) electronRunner.restart()
      })
    }
  }] : []
})

if (isDev) {
  await mainContext.watch()
} else {
  await mainContext.rebuild()
  mainContext.dispose()
}
