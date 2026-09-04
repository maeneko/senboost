import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * На Linux `app.setLoginItemSettings` не работает (Electron поддерживает его только на macOS
 * и Windows), поэтому пишем .desktop-файл в каталог автозапуска — общее для GNOME, KDE, XFCE
 * соглашение freedesktop.
 */
function autostartFilePath(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
  return join(configHome, 'autostart', 'senboost.desktop')
}

/**
 * Внутри AppImage `process.execPath` указывает во временную точку монтирования, которая
 * исчезает после выхода, — запускать надо сам файл образа.
 */
function execCommand(): string {
  const binary = process.env['APPIMAGE'] || process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  return [binary, ...args, '--hidden'].map((part) => `"${part}"`).join(' ')
}

export async function isAppAutoStartEnabled(): Promise<boolean> {
  try {
    const content = await readFile(autostartFilePath(), 'utf8')
    // Файл могли оставить включённым, но отключить галочкой в «Автозапуске» окружения —
    // тогда в нём стоит X-GNOME-Autostart-enabled=false.
    return !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(content)
  } catch {
    return false
  }
}

export async function setAppAutoStart(enabled: boolean): Promise<void> {
  const path = autostartFilePath()

  if (!enabled) {
    await rm(path, { force: true })
    return
  }

  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=SenBoost',
    'Comment=Обход блокировок через zapret',
    `Exec=${execCommand()}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')

  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, entry, 'utf8')
}
